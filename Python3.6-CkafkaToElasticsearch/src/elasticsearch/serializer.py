try:
    import simplejson as json
except ImportError:
    import json

import uuid
from datetime import date, datetime
from decimal import Decimal

from .exceptions import SerializationError, ImproperlyConfigured
from .compat import string_types

INTEGER_TYPES = ()
FLOAT_TYPES = (Decimal,)
TIME_TYPES = (date, datetime)

try:
    import numpy as np

    INTEGER_TYPES += (
        np.int_,
        np.intc,
        np.int8,
        np.int16,
        np.int32,
        np.int64,
        np.uint8,
        np.uint16,
        np.uint32,
        np.uint64,
    )
    FLOAT_TYPES += (
        np.float_,
        np.float16,
        np.float32,
        np.float64,
    )
except ImportError:
    np = None

try:
    import pandas as pd

    TIME_TYPES += (pd.Timestamp,)
except ImportError:
    pd = None


class TextSerializer(object):
    mimetype = "text/plain"

    def loads(self, s):
        return s

    def dumps(self, data):
        if isinstance(data, string_types):
            return data

        raise SerializationError("Cannot serialize %r into text." % data)


class JSONSerializer(object):
    mimetype = "application/json"

    def default(self, data):
        if isinstance(data, TIME_TYPES):
            return data.isoformat()
        elif isinstance(data, uuid.UUID):
            return str(data)
        elif isinstance(data, FLOAT_TYPES):
            return float(data)
        elif INTEGER_TYPES and isinstance(data, INTEGER_TYPES):
            return int(data)

        # Special cases for numpy and pandas types
        elif np:
            if isinstance(data, np.bool_):
                return bool(data)
            elif isinstance(data, np.datetime64):
                return data.item().isoformat()
            elif isinstance(data, np.ndarray):
                return data.tolist()
        if pd:
            if isinstance(data, (pd.Series, pd.Categorical)):
                return data.tolist()
            elif hasattr(pd, "NA") and pd.isna(data):
                return None

        raise TypeError("Unable to serialize %r (type: %s)" % (data, type(data)))

    def loads(self, s):
        try:
            return json.loads(s)
        except (ValueError, TypeError) as e:
            raise SerializationError(s, e)

    def dumps(self, data):
        # don't serialize strings
        if isinstance(data, string_types):
            return data

        try:
            return json.dumps(
                data, default=self.default, ensure_ascii=False, separators=(",", ":")
            )
        except (ValueError, TypeError) as e:
            raise SerializationError(data, e)


DEFAULT_SERIALIZERS = {
    JSONSerializer.mimetype: JSONSerializer(),
    TextSerializer.mimetype: TextSerializer(),
}


class Deserializer(object):
    def __init__(self, serializers, default_mimetype="application/json"):
        try:
            self.default = serializers[default_mimetype]
        except KeyError:
            raise ImproperlyConfigured(
                "Cannot find default serializer (%s)" % default_mimetype
            )
        self.serializers = serializers

    def loads(self, s, mimetype=None):
        if not mimetype:
            deserializer = self.default
        else:
            # split out charset
            mimetype, _, _ = mimetype.partition(";")
            try:
                deserializer = self.serializers[mimetype]
            except KeyError:
                raise SerializationError(
                    "Unknown mimetype, unable to deserialize: %s" % mimetype
                )

        return deserializer.loads(s)