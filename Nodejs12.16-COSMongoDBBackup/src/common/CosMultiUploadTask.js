/* eslint-disable no-param-reassign */
/* eslint-disable prefer-const */
/* eslint-disable prefer-destructuring */
const CosSdk = require('cos-nodejs-sdk-v5');
const Async = require('async');
const { retry, getUUID, readStreamAddPassThrough } = require('./utils');

class CosMultiUploadTask {
  constructor({
    cosSdkInstance,
    object,
    getReadStream,
    parallel = 9,
    maxTryTime = 3,
    putObjectLimit = 8 * 1024 * 1024,
    defaultChunkSize,
    mode = 'ALL_UPLOAD_ID_ALLOW',
    cacheData,
    globalCacheKey = 'COS_MULTI_UPLOAD_TASK',
  }) {
    Object.assign(this, {
      object,
      getReadStream,
      parallel,
      maxTryTime,
      putObjectLimit,
      defaultChunkSize:
        defaultChunkSize || this.getDefaultChunkSize(object.ContentLength),
      mode,
      globalCacheKey,
      status: 'waiting',
      cancelError: null,
      runningStream: {},
      resultData: {},
    });
    this.presetCosSdkInstance(cosSdkInstance);
    this.initCacheData(cacheData);
  }
  /**
   * add force cancel and retry methods to cosSdkInstance
   */
  presetCosSdkInstance(cosSdkInstance) {
    const methods = Object.keys(CosSdk.prototype).filter(method => !method.includes('Retry'));
    const result = {};
    methods.forEach((method) => {
      result[method] = (...args) => cosSdkInstance[method](...args);
      result[`${method}Retry`] = retry({
        func: async (...args) => {
          if (this.status === 'canceled') {
            throw this.cancelError;
          }
          const uuid = getUUID();
          let { Body = {}, GetBody } = args[0] || {};
          if (GetBody) {
            Body = GetBody();
            args[0].Body = Body;
          }
          if (typeof Body.pipe === 'function') {
            this.runningStream[uuid] = Body;
          }
          try {
            const res = await cosSdkInstance[method](...args);
            return res;
          } catch (err) {
            throw err;
          } finally {
            delete this.runningStream[uuid];
          }
        },
        maxTryTime: this.maxTryTime,
      });
    });
    this.cosSdkInstance = result;
  }
  /**
   * init cache data module
   * if cacheData object is deliver from params, use it
   * otherwise get cacheData object from global
   */
  initCacheData(cacheData) {
    if (cacheData) {
      this.cacheData = cacheData;
    } else {
      this.cacheData = this.manageGlobalCacheData('get');
    }
  }
  /**
   * get or remove cacheData object from global
   */
  manageGlobalCacheData(action) {
    const { Bucket, Region, Key, Hash } = this.getParams();
    const { globalCacheKey } = this;
    const uuid = `${Bucket}-${Region}-${Key}-${Hash || ''}`;
    if (action === 'get') {
      global[globalCacheKey] = global[globalCacheKey] || {};
      global[globalCacheKey][uuid] = global[globalCacheKey][uuid] || {};
      return global[globalCacheKey][uuid];
    }
    if (global[globalCacheKey] && global[globalCacheKey][uuid]) {
      delete global[globalCacheKey][uuid];
    }
    if (Object.keys(global[globalCacheKey]).length === 0) {
      delete global[globalCacheKey];
    }
  }
  /**
   * get params from object and cacheData
   */
  getParams() {
    return {
      ...this.object,
      ...this.cacheData,
    };
  }
  /**
   * calculate the available defaultChunkSize
   */
  getDefaultChunkSize(contentLength) {
    const STEP = [
      1,
      2,
      4,
      8,
      16,
      32,
      64,
      128,
      256,
      512,
      1024,
      2048,
      4096,
      5120,
    ];
    let available = 1024 * 1024;
    for (let i = 0; i < STEP.length; i++) {
      available = STEP[i] * 1024 * 1024;
      if (contentLength / available <= 10000) break;
    }
    return Math.max(available, 1024 * 1024);
  }
  /**
   * get upload id
   * if cacheData has upload id, use it
   * otherwise if mode is 'NEW_UPLOAD_ID_ONLY', that multipartInit and get the new upload id
   * otherwise if mode is 'ALL_UPLOAD_ID_ALLOW', that try to get the useful upload id by multipartList
   */
  async multipartInit() {
    if (this.cacheData.UploadId) {
      return;
    }
    const { Bucket, Region, Key } = this.getParams();
    const { ContentLength, ...multipartInitParams } = this.object;
    if (this.mode === 'NEW_UPLOAD_ID_ONLY') {
      const { UploadId } = await this.cosSdkInstance.multipartInitRetry(multipartInitParams);
      this.cacheData.UploadId = UploadId;
    } else {
      const { Upload = [] } = await this.cosSdkInstance.multipartListRetry({
        Bucket,
        Region,
        Prefix: Key,
      });
      const uploadIds = Upload.filter(item => item.Key === Key).map(item => item.UploadId);
      if (uploadIds.length) {
        this.cacheData.UploadId = uploadIds[0];
      } else {
        const { UploadId } = await this.cosSdkInstance.multipartInitRetry(multipartInitParams);
        this.cacheData.UploadId = UploadId;
      }
    }
    this.cacheData.Parts = [];
  }
  /**
   * list uploaded parts and update cacheData
   */
  async multipartListPart() {
    const { Bucket, Region, Key, UploadId, ContentLength } = this.getParams();
    const { defaultChunkSize } = this;
    let Part = [];
    const params = {
      Bucket,
      Region,
      Key,
      UploadId,
    };
    while (true) {
      const {
        Part: SomePart = [],
        NextPartNumberMarker,
        IsTruncated,
      } = await this.cosSdkInstance.multipartListPartRetry({
        ...params,
      });
      Part.push(...SomePart);
      if (IsTruncated === 'true') {
        params.PartNumberMarker = NextPartNumberMarker;
      } else {
        break;
      }
    }
    const uploadedETag = Part.reduce((res, { PartNumber, ETag }) => {
      res[`${PartNumber}`] = ETag;
      return res;
    }, {});
    const maxPartNumber = Math.ceil(ContentLength / defaultChunkSize);
    const Parts = Array(maxPartNumber)
      .fill()
      .map((item, index) => ({
        PartNumber: index + 1,
        ETag: uploadedETag[`${index + 1}`],
      }));
    this.cacheData.Parts = Parts;
  }
  /**
   * upload one part
   */
  async multipartUploadOnePart({ PartNumber, ETag }) {
    if (ETag) {
      return {
        PartNumber,
        ETag,
      };
    }
    const { Bucket, Region, Key, ContentLength, UploadId } = this.getParams();
    const { defaultChunkSize } = this;
    const streamSize =      defaultChunkSize * PartNumber <= ContentLength
      ? defaultChunkSize
      : ContentLength - defaultChunkSize * (PartNumber - 1);
    const start = defaultChunkSize * (PartNumber - 1);
    const end = start + streamSize;
    const result = await this.cosSdkInstance.multipartUploadRetry({
      Bucket,
      Region,
      Key,
      UploadId,
      PartNumber,
      ContentLength: streamSize,
      GetBody: () => readStreamAddPassThrough(this.getReadStream(start, end)),
    });
    this.updateParts({
      ...result,
      PartNumber,
    });
    return result;
  }
  /**
   * upload all parts parallelly
   */
  multipartUpload() {
    return new Promise((resolve, reject) => {
      Async.mapLimit(
        this.cacheData.Parts,
        this.parallel,
        async (part) => {
          try {
            const res = await this.multipartUploadOnePart(part);
            return res;
          } catch (error) {
            if (error.statusCode === 403) {
              throw new Error(JSON.stringify({
                statusCode: error.statusCode,
                headers: error.headers || {},
              }));
            }
            return {
              error,
            };
          }
        },
        (err, results) => {
          if (err) {
            reject(err);
            return;
          }
          const errors = results.map(item => item.error).filter(Boolean);
          if (errors.length) {
            reject(errors);
          } else {
            resolve();
          }
        },
      );
    });
  }
  /**
   * complete multipart upload
   */
  async multipartComplete() {
    const { Bucket, Region, Key, UploadId, Parts } = this.getParams();
    this.resultData = await this.cosSdkInstance.multipartCompleteRetry({
      Bucket,
      Region,
      Key,
      UploadId,
      Parts,
    });
    this.manageGlobalCacheData('remove');
  }
  /**
   * when a part upload success, update the Parts property of cacheData
   */
  updateParts({ PartNumber, ETag }) {
    const { Parts } = this.cacheData;
    const index = Parts.findIndex(item => item.PartNumber === PartNumber);
    if (index > -1) {
      Parts.splice(index, 1, { PartNumber, ETag });
    } else {
      Parts.push({ PartNumber, ETag });
    }
  }
  /**
   * upload the whole file by putObject
   */
  async putObject() {
    const { ContentLength } = this.object;
    this.resultData = await this.cosSdkInstance.putObjectRetry({
      ...this.object,
      GetBody: () => readStreamAddPassThrough(this.getReadStream(0, ContentLength)),
    });
    this.manageGlobalCacheData('remove');
  }
  /**
   * start upload task
   */
  async runTask() {
    try {
      this.status = 'running';
      const { ContentLength } = this.getParams();
      if (ContentLength > this.putObjectLimit) {
        await this.multipartInit();
        await this.multipartListPart();
        await this.multipartUpload();
        await this.multipartComplete();
      } else {
        await this.putObject();
      }
      return this.resultData;
    } catch (err) {
      throw err;
    } finally {
      process.nextTick(() => this.destroy());
    }
  }
  /**
   * cancel upload task
   */
  async cancelTask(err = new Error('cos upload task is canceled')) {
    this.status = 'canceled';
    this.cancelError = err;
    const uuids = Object.keys(this.runningStream);
    uuids.forEach((uuid) => {
      try {
        const stream = this.runningStream[uuid];
        delete this.runningStream[uuid];
        if (stream && stream.emit) {
          stream.emit('error', this.cancelError);
        }
      } catch (err) {}
    });
  }
  destroy() {
    this.object = null;
    this.getReadStream = null;
    this.parallel = null;
    this.maxTryTime = null;
    this.putObjectLimit = null;
    this.defaultChunkSize = null;
    this.mode = null;
    this.globalCacheKey = null;
    this.status = null;
    this.cancelError = null;
    this.runningStream = null;
    this.resultData = null;
    this.cosSdkInstance = null;
    this.cacheData = null;
  }
}

module.exports = CosMultiUploadTask;
