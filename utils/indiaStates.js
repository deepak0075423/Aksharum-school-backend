'use strict';
/**
 * Indian states & union territories + PIN-code helpers.
 * Keep this list in sync with school-frontend/src/utils/indiaStates.js and
 * Nexora-Hives/utils/indiaStates.ts.
 */

const STATES = [
    'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa',
    'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala',
    'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland',
    'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura',
    'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
];

const UNION_TERRITORIES = [
    'Andaman and Nicobar Islands', 'Chandigarh',
    'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Jammu and Kashmir',
    'Ladakh', 'Lakshadweep', 'Puducherry',
];

const STATES_AND_UTS = [...STATES, ...UNION_TERRITORIES].sort((a, b) => a.localeCompare(b));

// First two digits of a PIN identify the postal circle. Used as an offline
// fallback when the India Post lookup is unreachable — gives the state (not the
// city), which is better than leaving the form blank.
const PIN_PREFIX_STATE = {
    11: 'Delhi',
    12: 'Haryana', 13: 'Haryana',
    14: 'Punjab', 15: 'Punjab', 16: 'Punjab',
    17: 'Himachal Pradesh',
    18: 'Jammu and Kashmir', 19: 'Jammu and Kashmir',
    20: 'Uttar Pradesh', 21: 'Uttar Pradesh', 22: 'Uttar Pradesh', 23: 'Uttar Pradesh',
    24: 'Uttar Pradesh', 25: 'Uttar Pradesh', 26: 'Uttar Pradesh', 27: 'Uttar Pradesh',
    28: 'Uttar Pradesh',
    30: 'Rajasthan', 31: 'Rajasthan', 32: 'Rajasthan', 33: 'Rajasthan', 34: 'Rajasthan',
    36: 'Gujarat', 37: 'Gujarat', 38: 'Gujarat', 39: 'Gujarat',
    40: 'Maharashtra', 41: 'Maharashtra', 42: 'Maharashtra', 43: 'Maharashtra', 44: 'Maharashtra',
    45: 'Madhya Pradesh', 46: 'Madhya Pradesh', 47: 'Madhya Pradesh', 48: 'Madhya Pradesh',
    49: 'Chhattisgarh',
    50: 'Telangana', 51: 'Andhra Pradesh', 52: 'Andhra Pradesh', 53: 'Andhra Pradesh',
    56: 'Karnataka', 57: 'Karnataka', 58: 'Karnataka', 59: 'Karnataka',
    60: 'Tamil Nadu', 61: 'Tamil Nadu', 62: 'Tamil Nadu', 63: 'Tamil Nadu', 64: 'Tamil Nadu',
    67: 'Kerala', 68: 'Kerala', 69: 'Kerala',
    70: 'West Bengal', 71: 'West Bengal', 72: 'West Bengal', 73: 'West Bengal', 74: 'West Bengal',
    75: 'Odisha', 76: 'Odisha', 77: 'Odisha',
    78: 'Assam', 79: 'Arunachal Pradesh',
    80: 'Bihar', 81: 'Bihar', 82: 'Bihar', 83: 'Jharkhand', 84: 'Bihar', 85: 'Bihar',
    90: 'Army Post Office', 91: 'Army Post Office',
};

const isPincode = (v) => /^[1-9]\d{5}$/.test(String(v || '').trim());

const stateFromPincode = (pin) => {
    if (!isPincode(pin)) return '';
    const state = PIN_PREFIX_STATE[Number(String(pin).slice(0, 2))] || '';
    return STATES_AND_UTS.includes(state) ? state : '';
};

module.exports = { STATES, UNION_TERRITORIES, STATES_AND_UTS, PIN_PREFIX_STATE, isPincode, stateFromPincode };
