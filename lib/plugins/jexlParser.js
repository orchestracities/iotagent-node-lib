/*
 * Copyright 2016 Telefonica Investigación y Desarrollo, S.A.U
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
 * If not, seehttp://www.gnu.org/licenses/.
 *
 * For those usages not covered by the GNU Affero General Public License
 * please contact with::daniel.moranjimenez@telefonica.com
 *
 * Modified by: Daniel Calvo - ATOS Research & Innovation
 */

'use strict';

const jexl = require('jexl');
var errors = require('../errors'),
  config = require('../commonConfig');


jexl.addTransform('indexOf', (val, char) => String(val).indexOf(char));
jexl.addTransform('length', (val) => String(val).length);
jexl.addTransform('trim', (val) => String(val).trim());
jexl.addTransform('substr', (val, int1, int2) => String(val).substr(int1, int2));

function extractContext(attributeList) {
    var context = {};
    var value;

    for (var i = 0; i < attributeList.length; i++) {
        if (Number.parseInt(attributeList[i].value)) {
          value = Number.parseInt(attributeList[i].value);
        } else if (Number.parseFloat(attributeList[i].value)) {
          value = Number.parseFloat(attributeList[i].value);
        } else if (String(attributeList[i].value) === 'true') {
          value = true;
        } else if (String(attributeList[i].value) === 'false') {
          value = false;
        } else {
          value = attributeList[i].value;
        }
        context[attributeList[i].name] = value;
    }

    return context;
}

function applyExpression(expression, context, typeInformation) {
    return jexl.evalSync (expression, context);
}

function expressionApplier(context, typeInformation) {
    return function(attribute) {

        /**
         * Determines if a value is of type float
         *
         * @param      {String}   value       Value to be analyzed
         * @return     {boolean}              True if float, False otherwise.
         */
        function isFloat(value) {
            return !isNaN(value) && value.toString().indexOf('.') !== -1;
        }

        var newAttribute = {
            name: attribute.name,
            type: attribute.type
        };

        /*jshint camelcase: false */
        if (config.checkNgsi2() && attribute.object_id) {
            newAttribute.object_id = attribute.object_id;
        }

        newAttribute.value = applyExpression(attribute.expression, context, typeInformation);

        if (attribute.type === 'Number' && isFloat(newAttribute.value)) {
            newAttribute.value = Number.parseFloat(newAttribute.value);
        }
        else if (attribute.type === 'Number' && Number.parseInt(newAttribute.value)) {
            newAttribute.value = Number.parseInt(newAttribute.value);
        }
        else if (attribute.type === 'Boolean') {
            newAttribute.value = (newAttribute.value === 'true' || newAttribute.value === '1');
        }
        else if (attribute.type === 'None') {
            newAttribute.value = null;
        } else {
            newAttribute.value = String(newAttribute.value);
        }

        return newAttribute;
    };
}

function isTransform(identifier) {
  return jexl.getTransform(identifier) === ( null || undefined) ? false : true;
}

function contextAvailable(expression, context) {
  var error;
  try{
    var lexer = jexl._getLexer();
    var identifiers = lexer.tokenize(expression).filter(function(token) {
      return token.type === 'identifier';
    });
    var keys = Object.keys(context);
    var validContext = true;
    identifiers.some(function(element) {
      if (!keys.includes(element.value) && !isTransform(element.value)) {
        validContext = false;
      } 
      return validContext === false;
    });
    if(validContext) {
      jexl.evalSync (expression, context);
    }
    return validContext;
  } catch (e) {
    error = new errors.InvalidExpression(expression);
    throw error;
  }
}

function processExpressionAttributes(typeInformation, list, context) {
    return list
        .filter(function(item) {
            return item.expression && contextAvailable(item.expression, context);
        })
        .map(expressionApplier(context, typeInformation));
}

exports.extractContext = extractContext;
exports.processExpressionAttributes = processExpressionAttributes;
exports.applyExpression = applyExpression;
