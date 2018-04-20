'use strict';
const _ = require('lodash');
const moment = require('moment-timezone');
const Q = require('q');
const request = require('request-promise');
const crypto = require('crypto');
const util = require('util');

module.exports = ['utilities', ({cache, options}) => {
    const utilities = {};
    utilities.dateRegex = /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[1-2][0-9]|3[0-1]) (2[0-3]|[01][0-9]):[0-5][0-9]$/;
    utilities.fullDateRegex = /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[1-2][0-9]|3[0-1])T(2[0-3]|[01][0-9]):[0-5][0-9](:[0-9]{2}\.[0-9]{3}Z)?$/;

    utilities.promisifyAll = function (protoOrObject) {
        Object.keys(protoOrObject).forEach(method => {
            protoOrObject[method+'Async'] = util.promisify(protoOrObject[method])
        })
    };

    utilities.reviveDates = function (key, value) {
        const regexIso8601 = /^(\d{4}|\+\d{6})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})\.(\d{1,})(Z|([\-+])(\d{2}):(\d{2}))?)?)?)?$/;
        let match;
        if (typeof value === 'string' && value.length > 6 && (match = value.match(regexIso8601))) {
            const milliseconds = Date.parse(match[0]);
            if (!isNaN(milliseconds)) {
                return new Date(milliseconds);
            }
        }
        return value;
    };

    utilities.convertLocalToUtc = function (date, city, country) {
        let query;
        if (city && country) {
            query = `${city}, ${country}`;
        } else {
            query = city;
        }
        const defer = Q.defer();
        if (!_.isDate(date) && !(typeof date === 'string' && (date.match(utilities.dateRegex) || date.match(utilities.fullDateRegex)))) {
            throw new Error('Date should be in format YYYY-MM-DD HH:mm or YYYY-MM-DDTHH:mm:ss.sssZ');
        }
        date = moment.utc(date).toDate();
        let version = 1.31;//cache version
        cache.wrap(`utc:${moment(date).toJSON()}:${query}:${version}`,
            (cc) => {
                request.get({
                    url: `https://maps.googleapis.com/maps/api/place/textsearch/json`,
                    qs: {
                        key: options.googleApisPlaceKey,
                        query: query
                    },
                    json: true
                }).then((result) => {
                    const location = _.get(result, 'results[0].geometry.location');
                    if (location) {
                        if (date) {
                            return request.get({
                                    url: `http://api.geonames.org/timezoneJSON`,
                                    qs: {
                                        username: options.geoNamesUsername,
                                        lat: location.lat,
                                        lng: location.lng
                                    },
                                    json: true
                                })
                                .then(({timezoneId}) => {
                                    let utc = utilities.convertToUtcDate(date, timezoneId);
                                    return {
                                        utc: utc,
                                        timezone: timezoneId,
                                        timezoneOffset: utilities.getTimezoneOffset(date, timezoneId),
                                        local: utilities.convertUtcToLocal(utc, timezoneId),
                                        lat: location.lat,
                                        lng: location.lng
                                    };
                                });
                        } else {
                            return location;
                        }
                    } else {
                        const defer = Q.defer();
                        defer.reject(new Error(result.status));
                        return defer.promise;
                    }
                }).then((result) => cc(null, result)).catch(cc);
            }, (err, result) => {
                if (err) {
                    defer.reject(err);
                } else {
                    defer.resolve(result);
                }
            });

        return defer.promise;
    };

    utilities.getTimezoneOffset = function (localDate, timezoneId) {
        const offset = moment.tz(localDate, timezoneId).format('Z');
        const timezoneOffset = parseInt(offset.replace(':', '.').replace('.3', '.5'));
        return timezoneOffset;
    };

    utilities.convertToUtcDate = function (localDate, timezoneId) {
        let timezoneOffset = utilities.getTimezoneOffset(localDate, timezoneId);
        return moment.utc(localDate).add({h: -timezoneOffset}).toJSON();
    };

    utilities.convertUtcToLocal = function (date, timezone) {
        const localeOffset = utilities.getTimezoneOffset(date, timezone);
        return moment.utc(date).add({hours: localeOffset}).toJSON();
    };

    /**
     * When an error is stringified it comes out as plain empty object. We want the stack and
     * @param error
     * @param [skipStack=false] skip stack
     * @returns {*}
     */
    utilities.errorToObject = function (error, skipStack) {
        if (error instanceof Error) {
            const result = {};
            Object.getOwnPropertyNames(error).forEach(function (key) {
                if (key === 'stack' && skipStack) {
                    return;
                }
                result[key] = error[key];
            });
            return result;
        } else {
            return error;
        }
    };
    /**
     * Transforms the object. Transformations are described by the properties object.
     * 'propName': include that property,
     * { 'propName': 'path.to.pick' }
     * { '-': [propNames to skip]}
     * { 'propName': function (object) { return <value_for_that_property> } }
     * @param object
     * @param [path] apply the transformation only to this property. { 'pickAs': 'pickFrom.path' }
     * @param properties {String|Object}
     * @returns {{}}
     */
    utilities.transformThatObject = function (object, path, properties) {
        if (arguments.length === 2) {
            properties = path;
            path = null;
        }
        let finalResult;
        let pathAs, pathFrom;
        if (path) {
            for (let k in path) {
                pathAs = k;
                pathFrom = path[k];
            }
            finalResult = _.extend({}, object);
            object = _.get(object, pathFrom);
        }
        let transformedObject;
        if (_.isArray(object)) {
            transformedObject = _.map(object, _.partial(utilities._transformSingleObject, _, properties));
        } else {
            transformedObject = utilities._transformSingleObject(object, properties);
        }

        if (path) {
            finalResult[pathAs] = transformedObject;
        } else {
            finalResult = transformedObject;
        }

        return finalResult;
    };

    utilities._transformSingleObject = function (object, properties) {
        const transformedObject = {};
        let toDelete = [];
        _.each(properties, function (value) {
            let objectValue, objectKey;
            switch (typeof value) {
                case 'string':
                    objectValue = object[value];
                    objectKey = value;
                    break;
                case 'object':
                    for (var key in value) { //get the first key in the object value of the transformation definition
                        break;
                    }
                    objectKey = key;
                    let p = value[key];
                    if (key === '-') {
                        toDelete = toDelete.concat(p);
                    } else {
                        switch (typeof p) {
                            case 'string':
                                objectValue = _.get(object, p);
                                break;
                            case 'function':
                                objectValue = p.call(null, object);
                                break;
                            default:
                                throw new Error('invalid transformation for :' + key);
                        }
                    }
                    break;
            }
            if (objectValue !== undefined) {
                transformedObject[objectKey] = objectValue;
            }
        });

        return _.omit(transformedObject, toDelete);
    };

    utilities.getClearObject = function (obj, rejectEmptyObjectsOnFirstLevel) {
        if (obj && obj.toJSON) {
            return utilities.getClearObject(obj.toJSON());
        }
        if (_.isError(obj)) {
            return utilities.errorToObject(obj);
        }
        if (_.isObject(obj)) {
            const clearObject = _.isArray(obj) ? [] : {};
            _.each(obj, function (val, key) {
                if (_.isFunction(val)) {
                    return;
                }
                const clearValue = utilities.getClearObject(val, true);
                if (clearValue !== null && clearValue !== undefined && clearValue !== '') {
                    if (_.isArray(clearObject)) {
                        clearObject.push(clearValue);
                    } else {
                        clearObject[key] = clearValue;
                    }
                }
            });
            if (_.isEmpty(clearObject)) {
                if (!rejectEmptyObjectsOnFirstLevel) {
                    if (_.isObject(clearObject)) {
                        return {};
                    }
                    if (_.isArray(clearObject)) {
                        return [];
                    }
                }
                return null;
            }
            return clearObject;
        } else {
            return obj;
        }
    };

    utilities.zeroPad = function (num, places, char) {
        char = char !== undefined ? char : '0';
        const zero = places - num.toString().length + 1;
        return new Array(+(zero > 0 && zero)).join(char) + num;
    };

    utilities.randomString = function (length) {
        return crypto.randomBytes(length).toString('hex');
    };

    return {
        utilities
    }
}];
