'use strict';

const exitCodeDescriptions = {
    0: 'Success',
    1: 'Configuration file is missing',
    2: 'MAC address is missing',
    3: 'Command execution failed',
    4: 'ICT test failed',
    5: 'Test point test failed',
    6: 'EEPROM programming failed',
    7: 'MAC programming failed',
    8: 'Tamper sensor test failed',
    9: 'Vendor site is missing in configuration',
    10: 'OTP is not blank',
    11: 'EEPROM is not blank',
    12: 'Not all tests passed',
    13: 'Functional test failed',
    14: 'Invalid argument',
    15: 'Hardware precheck failed',
    16: 'POE test failed'
};

module.exports = {
    exitCodeDescriptions
};
