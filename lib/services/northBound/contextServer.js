/*
 * Copyright 2014 Telefonica Investigación y Desarrollo, S.A.U
 *
 * This file is part of fiware-iotagent-lib
 *
 * fiware-iotagent-lib is free software: you can redistribute it and/or
 * modify it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the License,
 * or (at your option) any later version.
 *
 * fiware-iotagent-lib is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public
 * License along with fiware-iotagent-lib.
 * If not, see http://www.gnu.org/licenses/.
 *
 * For those usages not covered by the GNU Affero General Public License
 * please contact with::daniel.moranjimenez@telefonica.com
 *
 * Modified by: Daniel Calvo - ATOS Research & Innovation
 */

/* eslint-disable no-useless-escape */
/* eslint-disable no-unused-vars */
/* eslint-disable no-prototype-builtins */
/* eslint-disable consistent-return */

const async = require('async');
const apply = async.apply;
const logger = require('logops');
const constants = require('../../constants');
const errors = require('../../errors');
const ngsi = require('../ngsi/ngsiService');
const intoTrans = require('../common/domain').intoTrans;
const deviceService = require('../devices/deviceService');
const commands = require('../commands/commandService');
const middlewares = require('../common/genericMiddleware');
const _ = require('underscore');
const config = require('../../commonConfig');
const context = {
    op: 'IoTAgentNGSI.ContextServer'
};
const updateContextTemplateNgsi1 = require('../../templates/updateContextNgsi1.json');
const updateContextTemplateNgsi2 = require('../../templates/updateContextNgsi2.json');
const queryContextTemplate = require('../../templates/queryContext.json');
const notificationTemplateNgsi1 = require('../../templates/notificationTemplateNgsi1.json');
const notificationTemplateNgsi2 = require('../../templates/notificationTemplateNgsi2.json');
let notificationMiddlewares = [];
let updateHandler;
let commandHandler;
let queryHandler;
let notificationHandler;

/**
 * Create the response for an UpdateContext operation, based on the results of the individual updates. The signature
 * retains the results object for homogeinity with the createQuery* version.
 *
 * @param {Object} req              Request that was handled in first place.
 * @param {Object} res              Response that will be sent.
 * @param {Object} results          Ignored for this function. TODO: to be removed in later versions.
 * @return {{contextResponses: Array}}
 */
function createUpdateResponse(req, res, results) {
    const result = {
        contextResponses: []
    };

    for (let i = 0; i < req.body.contextElements.length; i++) {
        const contextResponse = {
            contextElement: {
                attributes: req.body.contextElements[i].attributes,
                id: req.body.contextElements[i].id,
                isPattern: false,
                type: req.body.contextElements[i].type
            },
            statusCode: {
                code: 200,
                reasonPhrase: 'OK'
            }
        };

        for (let j = 0; j < contextResponse.contextElement.attributes.length; j++) {
            contextResponse.contextElement.attributes[i].value = '';
        }

        result.contextResponses.push(contextResponse);
    }

    logger.debug(context, 'Generated update response: %j', result);

    return result;
}

/**
 * Create the response for a queryContext operation based on the individual results gathered from the query handlers.
 * The returned response is in the NGSI Response format.
 *
 * @param {Object} req              Request that was handled in first place.
 * @param {Object} res              Response that will be sent.
 * @param {Object} results          Individual Context Element results from the query handlers.
 * @return {{contextResponses: Array}}
 */
function createQueryResponse(req, res, results) {
    const result = {
        contextResponses: []
    };

    for (let i = 0; i < results.length; i++) {
        const contextResponse = {
            contextElement: results[i],
            statusCode: {
                code: 200,
                reasonPhrase: 'OK'
            }
        };

        contextResponse.contextElement.isPattern = false;

        result.contextResponses.push(contextResponse);
    }

    logger.debug(context, 'Generated query response: %j', result);

    return result;
}

/**
 * Retrieve the Device that corresponds to a Context Update, and execute the update side effects
 * if there were any (e.g.: creation of attributes related to comands).
 *
 * @param {String} device           Object that contains all the information about the device.
 * @param {String} id               Entity ID of the device to find.
 * @param {String} type             Type of the device to find.
 * @param {String} service          Service of the device.
 * @param {String} subservice       Subservice of the device.
 * @param {Array}  attributes       List of attributes to update with their types and values.
 */
function executeUpdateSideEffects(device, id, type, service, subservice, attributes, callback) {
    const sideEffects = [];

    if (device.commands) {
        for (let i = 0; i < device.commands.length; i++) {
            for (let j = 0; j < attributes.length; j++) {
                if (device.commands[i].name === attributes[j].name) {
                    const newAttributes = [
                        {
                            name: device.commands[i].name + '_status',
                            type: constants.COMMAND_STATUS,
                            value: 'PENDING'
                        }
                    ];

                    sideEffects.push(
                        apply(ngsi.update, device.name, device.resource, device.apikey, newAttributes, device)
                    );
                }
            }
        }
    }

    async.series(sideEffects, callback);
}

/**
 * Extract all the commands from the attributes section and add them to the Commands Queue.
 *
 * @param {String} device           Object that contains all the information about the device.
 * @param {String} id               Entity ID of the device to find.
 * @param {String} type             Type of the device to find.
 * @param {String} service          Service of the device.
 * @param {String} subservice       Subservice of the device.
 * @param {Array}  attributes       List of attributes to update with their types and values.
 */
function pushCommandsToQueue(device, id, type, service, subservice, attributes, callback) {
    async.map(attributes, apply(commands.add, service, subservice, device.id), callback);
}

/**
 * Generate all the update actions corresponding to a update context request using Ngsi1.
 * Update actions include updates in attributes and execution of commands. This action will
 * be called once per Context Element in the request.
 *
 * @param {Object} req                  Update request to generate Actions from
 * @param {Object} contextElement       Context Element whose actions will be extracted.
 */
function generateUpdateActionsNgsi1(req, contextElement, callback) {
    function splitUpdates(device, callback) {
        let attributes = [];
        const commands = [];
        let found;

        if (device.commands) {
            attributeLoop: for (const i in contextElement.attributes) {
                for (const j in device.commands) {
                    if (contextElement.attributes[i].name === device.commands[j].name) {
                        commands.push(contextElement.attributes[i]);
                        found = true;
                        continue attributeLoop;
                    }
                }

                attributes.push(contextElement.attributes[i]);
            }
        } else {
            attributes = contextElement.attributes;
        }

        callback(null, attributes, commands, device);
    }

    function createActionsArray(attributes, commands, device, callback) {
        const updateActions = [];

        if (updateHandler) {
            updateActions.push(
                async.apply(
                    updateHandler,
                    contextElement.id,
                    contextElement.type,
                    req.headers['fiware-service'],
                    req.headers['fiware-servicepath'],
                    attributes
                )
            );
        }

        if (commandHandler) {
            if (device.polling) {
                updateActions.push(
                    async.apply(
                        pushCommandsToQueue,
                        device,
                        contextElement.id,
                        contextElement.type,
                        req.headers['fiware-service'],
                        req.headers['fiware-servicepath'],
                        contextElement.attributes
                    )
                );
            } else {
                updateActions.push(
                    async.apply(
                        commandHandler,
                        contextElement.id,
                        contextElement.type,
                        req.headers['fiware-service'],
                        req.headers['fiware-servicepath'],
                        commands
                    )
                );
            }
        }

        updateActions.push(
            async.apply(
                executeUpdateSideEffects,
                device,
                contextElement.id,
                contextElement.type,
                req.headers['fiware-service'],
                req.headers['fiware-servicepath'],
                contextElement.attributes
            )
        );

        callback(null, updateActions);
    }

    deviceService.getDeviceByName(
        contextElement.id,
        req.headers['fiware-service'],
        req.headers['fiware-servicepath'],
        function (error, deviceObj) {
            if (error) {
                callback(error);
            } else {
                async.waterfall(
                    [
                        apply(deviceService.findConfigurationGroup, deviceObj),
                        apply(
                            deviceService.mergeDeviceWithConfiguration,
                            ['lazy', 'internalAttributes', 'active', 'staticAttributes', 'commands', 'subscriptions'],
                            [null, null, [], [], [], [], []],
                            deviceObj
                        ),
                        splitUpdates,
                        createActionsArray
                    ],
                    callback
                );
            }
        }
    );
}

/**
 * Generate all the update actions corresponding to a update context request using Ngsi2.
 * Update actions include updates in attributes and execution of commands.
 *
 * @param {Object} req                  Update request to generate Actions from
 * @param {Object} contextElement       Context Element whose actions will be extracted.
 */
function generateUpdateActionsNgsi2(req, contextElement, callback) {
    let entityId;
    let entityType;

    if (contextElement.id && contextElement.type) {
        entityId = contextElement.id;
        entityType = contextElement.type;
    } else if (req.params.entity) {
        entityId = req.params.entity;
    }

    function splitUpdates(device, callback) {
        const attributes = [];
        const commands = [];
        let found;
        let newAtt;
        let i;

        if (device.commands) {
            attributeLoop: for (i in contextElement) {
                for (const j in device.commands) {
                    if (i === device.commands[j].name) {
                        newAtt = {};
                        newAtt[i] = contextElement[i];
                        newAtt[i].name = i;
                        commands.push(newAtt[i]);
                        found = true;
                        continue attributeLoop;
                    }
                }
            }
        }

        for (i in contextElement) {
            if (i !== 'type' && i !== 'id') {
                newAtt = {};
                newAtt = contextElement[i];
                newAtt.name = i;
                attributes.push(newAtt);
            }
        }

        callback(null, attributes, commands, device);
    }

    function createActionsArray(attributes, commands, device, callback) {
        const updateActions = [];

        if (!entityType) {
            entityType = device.type;
        }

        if (updateHandler) {
            updateActions.push(
                async.apply(
                    updateHandler,
                    entityId,
                    entityType,
                    req.headers['fiware-service'],
                    req.headers['fiware-servicepath'],
                    attributes
                )
            );
        }

        if (commandHandler) {
            if (device.polling) {
                updateActions.push(
                    async.apply(
                        pushCommandsToQueue,
                        device,
                        entityId,
                        entityType,
                        req.headers['fiware-service'],
                        req.headers['fiware-servicepath'],
                        attributes
                    )
                );
            } else {
                updateActions.push(
                    async.apply(
                        commandHandler,
                        entityId,
                        entityType,
                        req.headers['fiware-service'],
                        req.headers['fiware-servicepath'],
                        commands
                    )
                );
            }
        }

        updateActions.push(
            async.apply(
                executeUpdateSideEffects,
                device,
                entityId,
                entityType,
                req.headers['fiware-service'],
                req.headers['fiware-servicepath'],
                attributes
            )
        );

        callback(null, updateActions);
    }

    deviceService.getDeviceByName(entityId, req.headers['fiware-service'], req.headers['fiware-servicepath'], function (
        error,
        deviceObj
    ) {
        if (error) {
            callback(error);
        } else {
            async.waterfall(
                [
                    apply(deviceService.findConfigurationGroup, deviceObj),
                    apply(
                        deviceService.mergeDeviceWithConfiguration,
                        ['lazy', 'internalAttributes', 'active', 'staticAttributes', 'commands', 'subscriptions'],
                        [null, null, [], [], [], [], []],
                        deviceObj
                    ),
                    splitUpdates,
                    createActionsArray
                ],
                callback
            );
        }
    });
}

/**
 * Express middleware to manage incoming update context requests using NGSIv2.
 */
function handleUpdateNgsi2(req, res, next) {
    function reduceActions(actions, callback) {
        callback(null, _.flatten(actions));
    }

    if (updateHandler || commandHandler) {
        logger.debug(context, 'Handling update from [%s]', req.get('host'));
        logger.debug(context, req.body);

        async.waterfall(
            [apply(async.map, req.body.entities, apply(generateUpdateActionsNgsi2, req)), reduceActions, async.series],
            function (error, result) {
                if (error) {
                    logger.debug(context, 'There was an error handling the update action: %s.', error);

                    next(error);
                } else {
                    logger.debug(context, 'Update action from [%s] handled successfully.', req.get('host'));
                    res.status(204).json();
                }
            }
        );
    } else {
        logger.error(context, 'Tried to handle an update request before the update handler was stablished.');

        const errorNotFound = new Error({
            message: 'Update handler not found'
        });
        next(errorNotFound);
    }
}

/**
 * Express middleware to manage incoming UpdateContext requests using NGSIv1.
 * As NGSI10 requests can affect multiple entities, for each one of them a call
 * to the user update handler function is made.
 */
function handleUpdateNgsi1(req, res, next) {
    function reduceActions(actions, callback) {
        callback(null, _.flatten(actions));
    }

    if (updateHandler || commandHandler) {
        logger.debug(context, 'Handling update from [%s]', req.get('host'));
        logger.debug(context, req.body);

        async.waterfall(
            [
                apply(async.map, req.body.contextElements, apply(generateUpdateActionsNgsi1, req)),
                reduceActions,
                async.series
            ],
            function (error, result) {
                if (error) {
                    logger.debug(context, 'There was an error handling the update action: %s.', error);

                    next(error);
                } else {
                    logger.debug(context, 'Update action from [%s] handled successfully.', req.get('host'));
                    res.status(200).json(createUpdateResponse(req, res, result));
                }
            }
        );
    } else {
        logger.error(context, 'Tried to handle an update request before the update handler was stablished.');

        const errorNotFound = new Error({
            message: 'Update handler not found'
        });
        next(errorNotFound);
    }
}

/**
 * Handle queries coming to the IoT Agent via de Context Provider API (as a consequence of a query to a passive
 * attribute redirected by the Context Broker).
 *
 * @param {String} id           Entity name of the selected entity in the query.
 * @param {String} type         Type of the entity.
 * @param {String} service      Service the device belongs to.
 * @param {String} subservice   Division inside the service.
 * @param {Array} attributes    List of attributes to read.
 */
function defaultQueryHandlerNgsi1(id, type, service, subservice, attributes, callback) {
    const contextElement = {
        type,
        isPattern: false,
        id,
        attributes: []
    };

    deviceService.getDeviceByName(id, service, subservice, function (error, ngsiDevice) {
        if (error) {
            callback(error);
        } else {
            for (let i = 0; i < attributes.length; i++) {
                const lazyAttribute = _.findWhere(ngsiDevice.lazy, { name: attributes[i] });
                const command = _.findWhere(ngsiDevice.commands, { name: attributes[i] });
                let attributeType;

                if (command) {
                    attributeType = command.type;
                } else if (lazyAttribute) {
                    attributeType = lazyAttribute.type;
                } else {
                    attributeType = 'string';
                }

                contextElement.attributes.push({
                    name: attributes[i],
                    type: attributeType,
                    value: ''
                });
            }

            callback(null, contextElement);
        }
    });
}

/**
 * Handle queries coming to the IoT Agent via de Context Provider API (as a consequence of a query to a passive
 * attribute redirected by the Context Broker).
 *
 * @param {String} id           Entity name of the selected entity in the query.
 * @param {String} type         Type of the entity.
 * @param {String} service      Service the device belongs to.
 * @param {String} subservice   Division inside the service.
 * @param {Array} attributes    List of attributes to read.
 */
function defaultQueryHandlerNgsi2(id, type, service, subservice, attributes, callback) {
    const contextElement = {
        type,
        id
    };

    deviceService.getDeviceByName(id, service, subservice, function (error, ngsiDevice) {
        if (error) {
            callback(error);
        } else {
            for (let i = 0; i < attributes.length; i++) {
                const lazyAttribute = _.findWhere(ngsiDevice.lazy, { name: attributes[i] });
                const command = _.findWhere(ngsiDevice.commands, { name: attributes[i] });
                let attributeType;

                if (command) {
                    attributeType = command.type;
                } else if (lazyAttribute) {
                    attributeType = lazyAttribute.type;
                } else {
                    attributeType = 'string';
                }

                contextElement[attributes[i]] = {
                    type: attributeType,
                    value: ''
                };
            }

            callback(null, contextElement);
        }
    });
}

/**
 * Express middleware to manage incoming QueryContext requests using NGSIv1.
 * As NGSI10 requests can affect multiple entities, for each one of them a call
 * to the user query handler function is made.
 */
function handleQueryNgsi1(req, res, next) {
    function getName(element) {
        return element.name;
    }

    function addStaticAttributes(attributes, device, contextElement, callback) {
        function inAttributes(item) {
            return item.name && attributes.indexOf(item.name) >= 0;
        }

        if (device.staticAttributes) {
            const selectedAttributes = device.staticAttributes.filter(inAttributes);

            if (selectedAttributes.length > 0) {
                if (contextElement.attributes) {
                    contextElement.attributes = contextElement.attributes.concat(selectedAttributes);
                } else {
                    contextElement.attributes = selectedAttributes;
                }
            }
        }

        callback(null, contextElement);
    }

    function completeAttributes(attributes, device, callback) {
        if (attributes && attributes.length !== 0) {
            logger.debug(context, 'Handling received set of attributes: %j', attributes);
            callback(null, attributes);
        } else if (device.lazy) {
            logger.debug(context, 'Handling stored set of attributes: %j', attributes);
            callback(null, device.lazy.map(getName));
        } else {
            logger.debug(context, "Couldn't find any attributes. Handling with null reference");

            callback(null, null);
        }
    }

    function createQueryRequests(attributes, contextEntity, callback) {
        let actualHandler;

        if (queryHandler) {
            actualHandler = queryHandler;
        } else {
            actualHandler = defaultQueryHandlerNgsi1;
        }

        async.waterfall(
            [
                apply(
                    deviceService.getDeviceByName,
                    contextEntity.id,
                    req.headers['fiware-service'],
                    req.headers['fiware-servicepath']
                ),
                deviceService.findConfigurationGroup
            ],
            function handleFindDevice(error, device) {
                const executeCompleteAttributes = apply(completeAttributes, attributes, device);
                const executeQueryHandler = apply(
                    actualHandler,
                    contextEntity.id,
                    contextEntity.type,
                    req.headers['fiware-service'],
                    req.headers['fiware-servicepath']
                );
                const executeAddStaticAttributes = apply(addStaticAttributes, attributes, device);

                callback(
                    error,
                    apply(async.waterfall, [executeCompleteAttributes, executeQueryHandler, executeAddStaticAttributes])
                );
            }
        );
    }

    function handleQueryContextRequests(error, result) {
        if (error) {
            logger.debug(context, 'There was an error handling the query: %s.', error);
            next(error);
        } else {
            logger.debug(context, 'Query from [%s] handled successfully.', req.get('host'));
            res.status(200).json(createQueryResponse(req, res, result));
        }
    }

    logger.debug(context, 'Handling query from [%s]', req.get('host'));

    async.waterfall(
        [apply(async.map, req.body.entities, apply(createQueryRequests, req.body.attributes)), async.series],
        handleQueryContextRequests
    );
}

/**
 * Express middleware to manage incoming query context requests using NGSIv2.
 */
function handleQueryNgsi2(req, res, next) {
    function getName(element) {
        return element.name;
    }

    function addStaticAttributes(attributes, device, contextElement, callback) {
        function inAttributes(item) {
            return item.name && attributes.indexOf(item.name) >= 0;
        }

        if (device.staticAttributes) {
            let selectedAttributes = [];
            if (attributes === undefined || attributes.length === 0) {
                selectedAttributes = device.staticAttributes;
            } else {
                selectedAttributes = device.staticAttributes.filter(inAttributes);
            }

            for (const att in selectedAttributes) {
                contextElement[selectedAttributes[att].name] = {
                    type: selectedAttributes[att].type,
                    value: selectedAttributes[att].value
                };
            }
        }

        callback(null, contextElement);
    }

    function completeAttributes(attributes, device, callback) {
        if (attributes && attributes.length !== 0) {
            logger.debug(context, 'Handling received set of attributes: %j', attributes);
            callback(null, attributes);
        } else if (device.lazy) {
            logger.debug(context, 'Handling stored set of attributes: %j', attributes);
            const results = device.lazy.map(getName);
            callback(null, results);
        } else {
            logger.debug(context, "Couldn't find any attributes. Handling with null reference");

            callback(null, null);
        }
    }

    function finishQueryForDevice(attributes, contextEntity, actualHandler, device, callback) {
        let contextId = contextEntity.id;
        let contextType = contextEntity.type;
        if (!contextId) {
            contextId = device.id;
        }

        if (!contextType) {
            contextType = device.type;
        }

        deviceService.findConfigurationGroup(device, function (error, group) {
            const executeCompleteAttributes = apply(completeAttributes, attributes, group);
            const executeQueryHandler = apply(
                actualHandler,
                contextId,
                contextType,
                req.headers['fiware-service'],
                req.headers['fiware-servicepath']
            );
            const executeAddStaticAttributes = apply(addStaticAttributes, attributes, group);

            async.waterfall([executeCompleteAttributes, executeQueryHandler, executeAddStaticAttributes], callback);
        });
    }

    function createQueryRequest(attributes, contextEntity, callback) {
        let actualHandler;
        let getFunction;

        if (queryHandler) {
            actualHandler = queryHandler;
        } else {
            actualHandler = defaultQueryHandlerNgsi2;
        }

        if (contextEntity.id) {
            getFunction = apply(
                deviceService.getDeviceByName,
                contextEntity.id,
                req.headers['fiware-service'],
                req.headers['fiware-servicepath']
            );
        } else {
            getFunction = apply(
                deviceService.listDevicesWithType,
                contextEntity.type,
                req.headers['fiware-service'],
                req.headers['fiware-servicepath'],
                null,
                null
            );
        }

        getFunction(function handleFindDevice(error, innerDevice) {
            let deviceList = [];
            if (!innerDevice) {
                return callback(new errors.DeviceNotFound(contextEntity.id));
            }

            if (innerDevice.count) {
                if (innerDevice.count === 0) {
                    return callback(null, []);
                }
                deviceList = innerDevice.devices;
            } else {
                deviceList = [innerDevice];
            }

            async.map(
                deviceList,
                async.apply(finishQueryForDevice, attributes, contextEntity, actualHandler),
                function (error, results) {
                    if (error) {
                        callback(error);
                    } else if (innerDevice.count) {
                        callback(null, results);
                    } else if (Array.isArray(results) && results.length > 0) {
                        callback(null, results);
                    } else {
                        callback(null, results);
                    }
                }
            );
        });
    }

    function handleQueryContextRequests(error, result) {
        if (error) {
            logger.debug(context, 'There was an error handling the query: %s.', error);
            next(error);
        } else {
            logger.debug(context, 'Query from [%s] handled successfully.', req.get('host'));
            res.status(200).json(result);
        }
    }

    logger.debug(context, 'Handling query from [%s]', req.get('host'));
    const contextEntity = {};

    // At the present moment, IOTA supports query request with one entity and without patterns. This is aligned
    // with the utilization cases in combination with ContextBroker. Other cases are returned as error
    if (req.body.entities.length !== 1) {
        logger.warn(
            'queries with entities number different to 1 are not supported (%d found)',
            req.body.entities.length
        );
        handleQueryContextRequests({ code: 400, name: 'BadRequest', message: 'more than one entity in query' });
        return;
    }
    if (req.body.entities[0].idPattern) {
        logger.warn('queries with idPattern are not supported');
        handleQueryContextRequests({ code: 400, name: 'BadRequest', message: 'idPattern usage in query' });
        return;
    }

    contextEntity.id = req.body.entities[0].id;
    contextEntity.type = req.body.entities[0].type;
    const queryAtts = req.body.attrs;
    createQueryRequest(queryAtts, contextEntity, handleQueryContextRequests);
}

function handleNotificationNgsi1(req, res, next) {
    function checkStatus(statusCode, callback) {
        if (statusCode.code && statusCode.code === '200') {
            callback();
        } else {
            callback(new errors.NotificationError(statusCode.code));
        }
    }

    function extractInformation(contextResponse, callback) {
        deviceService.getDeviceByName(
            contextResponse.contextElement.id,
            req.headers['fiware-service'],
            req.headers['fiware-servicepath'],
            function (error, device) {
                if (error) {
                    callback(error);
                } else {
                    callback(null, device, contextResponse.contextElement.attributes);
                }
            }
        );
    }

    function applyNotificationMiddlewares(device, values, callback) {
        if (notificationMiddlewares.length > 0) {
            const firstMiddleware = notificationMiddlewares.slice(0, 1)[0];
            const rest = notificationMiddlewares.slice(1);
            const startMiddleware = apply(firstMiddleware, device, values);
            const composedMiddlewares = [startMiddleware].concat(rest);

            async.waterfall(composedMiddlewares, callback);
        } else {
            callback(null, device, values);
        }
    }

    function createNotificationHandler(contextResponse, callback) {
        async.waterfall(
            [
                apply(checkStatus, contextResponse.statusCode),
                apply(extractInformation, contextResponse),
                applyNotificationMiddlewares,
                notificationHandler
            ],
            callback
        );
    }

    function handleNotificationRequests(error) {
        if (error) {
            logger.error(context, 'Error found when processing notification: %j', error);
            next(error);
        } else {
            res.status(200).json({});
        }
    }

    if (notificationHandler) {
        logger.debug(context, 'Handling notification from [%s]', req.get('host'));

        async.map(req.body.contextResponses, createNotificationHandler, handleNotificationRequests);
    } else {
        const errorNotFound = new Error({
            message: 'Notification handler not found'
        });

        logger.error(context, 'Tried to handle a notification before notification handler was established.');

        next(errorNotFound);
    }
}

function handleNotificationNgsi2(req, res, next) {
    function extractInformation(dataElement, callback) {
        const atts = [];
        for (const key in dataElement) {
            if (dataElement.hasOwnProperty(key)) {
                if (key !== 'id' && key !== 'type') {
                    const att = {};
                    att.type = dataElement[key].type;
                    att.value = dataElement[key].value;
                    att.name = key;
                    atts.push(att);
                }
            }
        }
        deviceService.getDeviceByName(
            dataElement.id,
            req.headers['fiware-service'],
            req.headers['fiware-servicepath'],
            function (error, device) {
                if (error) {
                    callback(error);
                } else {
                    callback(null, device, atts);
                }
            }
        );
    }

    function applyNotificationMiddlewares(device, values, callback) {
        if (notificationMiddlewares.length > 0) {
            const firstMiddleware = notificationMiddlewares.slice(0, 1)[0];
            const rest = notificationMiddlewares.slice(1);
            const startMiddleware = apply(firstMiddleware, device, values);
            const composedMiddlewares = [startMiddleware].concat(rest);

            async.waterfall(composedMiddlewares, callback);
        } else {
            callback(null, device, values);
        }
    }

    function createNotificationHandler(contextResponse, callback) {
        async.waterfall(
            [apply(extractInformation, contextResponse), applyNotificationMiddlewares, notificationHandler],
            callback
        );
    }

    function handleNotificationRequests(error) {
        if (error) {
            logger.error(context, 'Error found when processing notification: %j', error);
            next(error);
        } else {
            res.status(200).json({});
        }
    }

    if (notificationHandler) {
        logger.debug(context, 'Handling notification from [%s]', req.get('host'));
        async.map(req.body.data, createNotificationHandler, handleNotificationRequests);
    } else {
        const errorNotFound = new Error({
            message: 'Notification handler not found'
        });

        logger.error(context, 'Tried to handle a notification before notification handler was established.');

        next(errorNotFound);
    }
}

/**
 * Sets the new user handler for Entity update requests. This handler will be called whenever an update request arrives
 * with the following parameters: (id, type, attributes, callback). The callback is in charge of updating the
 * corresponding values in the devices with the appropriate protocol.
 *
 * In the case of NGSI requests affecting multiple entities, this handler will be called multiple times, one for each
 * entity, and all the results will be combined into a single response.
 *
 * @param {Function} newHandler         User handler for update requests
 */
function setUpdateHandler(newHandler) {
    updateHandler = newHandler;
}

/**
 * Sets the new user handler for commadn execution requests. This handler will be called whenever an update request
 * arrives to a with the following parameters: (id, type, attributes, callback). The callback is in charge of updating
 * the corresponding values in the devices with the appropriate protocol.
 *
 * In the case of NGSI requests affecting multiple entities, this handler will be called multiple times, one for each
 * entity, and all the results will be combined into a single response.
 *
 * @param {Function} newHandler         User handler for update requests
 */
function setCommandHandler(newHandler) {
    commandHandler = newHandler;
}

/**
 * Sets the new user handler for Entity query requests. This handler will be called whenever an update request arrives
 * with the following parameters: (id, type, attributes, callback). The handler must retrieve all the corresponding
 * information from the devices and return a NGSI entity with the requested values.
 *
 * In the case of NGSI requests affecting multiple entities, this handler will be called multiple times, one for each
 * entity, and all the results will be combined into a single response.

 * @param {Function} newHandler         User handler for query requests
 */
function setQueryHandler(newHandler) {
    queryHandler = newHandler;
}

/**
 * Sets the new user handler for entity change notifications. This candler will be called for each notification in an
 * entity the IOTA is subscribed to.
 *
 * In the case of NGSI requests affecting multiple entities, this handler will be called multiple times, one for each
 * entity, and all the results will be combined into a single response.
 *
 * @param {Function} newHandler         User handler for incoming notifications
 *
 */
function setNotificationHandler(newHandler) {
    notificationHandler = newHandler;
}

function queryErrorHandlingNgsi1(error, req, res, next) {
    let code = 500;

    logger.debug(context, 'Query NGSIv1 error [%s] handling request: %s', error.name, error.message);

    if (error.code && String(error.code).match(/^[2345]\d\d$/)) {
        code = error.code;
    }

    res.status(code).json({
        errorCode: {
            code,
            reasonPhrase: error.name,
            details: error.message.replace(/[<>\"\'=;\(\)]/g, '')
        }
    });
}

function queryErrorHandlingNgsi2(error, req, res, next) {
    let code = 500;

    logger.debug(context, 'Query NGSIv2 error [%s] handling request: %s', error.name, error.message);

    if (error.code && String(error.code).match(/^[2345]\d\d$/)) {
        code = error.code;
    }

    res.status(code).json({
        error: error.name,
        description: error.message.replace(/[<>\"\'=;\(\)]/g, '')
    });
}

function updateErrorHandlingNgsi1(error, req, res, next) {
    let code = 500;

    logger.debug(context, 'Update NGSIv1 error [%s] handing request: %s', error.name, error.message);

    if (error.code && String(error.code).match(/^[2345]\d\d$/)) {
        code = error.code;
    }

    res.status(code).json({
        contextResponses: [
            {
                contextElement: req.body,
                statusCode: {
                    code,
                    reasonPhrase: error.name,
                    details: error.message.replace(/[<>\"\'=;\(\)]/g, '')
                }
            }
        ]
    });
}

function updateErrorHandlingNgsi2(error, req, res, next) {
    let code = 500;

    logger.debug(context, 'Update NGSIv2 error [%s] handing request: %s', error.name, error.message);

    if (error.code && String(error.code).match(/^[2345]\d\d$/)) {
        code = error.code;
    }

    res.status(code).json({
        error: error.name,
        description: error.message.replace(/[<>\"\'=;\(\)]/g, '')
    });
}

/**
 * Load the routes related to context dispatching (NGSI10 calls).
 *
 * @param {Object} router      Express request router object.
 */
function loadContextRoutes(router) {
    //TODO: remove '//' paths when the appropriate patch comes to Orion
    const updateMiddlewaresNgsi1 = [
        middlewares.ensureType,
        middlewares.validateJson(updateContextTemplateNgsi1),
        handleUpdateNgsi1,
        updateErrorHandlingNgsi1
    ];
    const updateMiddlewaresNgsi2 = [
        middlewares.ensureType,
        middlewares.validateJson(updateContextTemplateNgsi2),
        handleUpdateNgsi2,
        updateErrorHandlingNgsi2
    ];
    const queryMiddlewaresNgsi1 = [
        middlewares.ensureType,
        middlewares.validateJson(queryContextTemplate),
        handleQueryNgsi1,
        queryErrorHandlingNgsi1
    ];
    const queryMiddlewaresNgsi2 = [handleQueryNgsi2, queryErrorHandlingNgsi2];
    const updatePathsNgsi1 = ['/v1/updateContext', '/NGSI10/updateContext', '//updateContext'];
    const updatePathsNgsi2 = ['/v2/op/update', '//op/update'];
    const queryPathsNgsi1 = ['/v1/queryContext', '/NGSI10/queryContext', '//queryContext'];
    const queryPathsNgsi2 = ['/v2/op/query', '//op/query'];
    // In a more evolved implementation, more endpoints could be added to queryPathsNgsi2
    // according to http://fiware.github.io/specifications/ngsiv2/stable.

    logger.info(context, 'Loading NGSI Contect server routes');
    let i;
    if (config.checkNgsi2()) {
        for (i = 0; i < updatePathsNgsi2.length; i++) {
            router.post(updatePathsNgsi2[i], updateMiddlewaresNgsi2);
        }
        for (i = 0; i < queryPathsNgsi2.length; i++) {
            router.post(queryPathsNgsi2[i], queryMiddlewaresNgsi2);
        }
        router.post('/notify', [
            middlewares.ensureType,
            middlewares.validateJson(notificationTemplateNgsi2),
            handleNotificationNgsi2,
            queryErrorHandlingNgsi2
        ]);
    } else {
        for (i = 0; i < updatePathsNgsi1.length; i++) {
            router.post(updatePathsNgsi1[i], updateMiddlewaresNgsi1);
        }
        for (i = 0; i < queryPathsNgsi1.length; i++) {
            router.post(queryPathsNgsi1[i], queryMiddlewaresNgsi1);
        }
        router.post('/notify', [
            middlewares.ensureType,
            middlewares.validateJson(notificationTemplateNgsi1),
            handleNotificationNgsi1,
            queryErrorHandlingNgsi1
        ]);
    }
}

function addNotificationMiddleware(newMiddleware) {
    notificationMiddlewares.push(newMiddleware);
}

function clear(callback) {
    notificationMiddlewares = [];
    notificationHandler = null;
    commandHandler = null;
    updateHandler = null;

    if (callback) {
        callback();
    }
}

exports.clear = clear;
exports.loadContextRoutes = intoTrans(context, loadContextRoutes);
exports.setUpdateHandler = intoTrans(context, setUpdateHandler);
exports.setCommandHandler = intoTrans(context, setCommandHandler);
exports.setNotificationHandler = intoTrans(context, setNotificationHandler);
exports.addNotificationMiddleware = intoTrans(context, addNotificationMiddleware);
exports.setQueryHandler = intoTrans(context, setQueryHandler);
