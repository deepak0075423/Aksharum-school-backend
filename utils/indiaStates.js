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

// Where the first THREE digits settle it differently from the first two: the
// north-east shares circle 79, Goa sits in Maharashtra's 40, Sikkim and the
// Andaman and Nicobar Islands in West Bengal's 73/74, Ladakh in J&K's 19,
// Uttarakhand in Uttar Pradesh's 24/26, Jharkhand in Bihar's 81/82.
const PIN3_STATE = {
    194: 'Ladakh',
    248: 'Uttarakhand', 249: 'Uttarakhand', 263: 'Uttarakhand',
    403: 'Goa',
    737: 'Sikkim', 744: 'Andaman and Nicobar Islands',
    790: 'Arunachal Pradesh', 791: 'Arunachal Pradesh', 792: 'Arunachal Pradesh',
    793: 'Meghalaya', 794: 'Meghalaya', 795: 'Manipur', 796: 'Mizoram',
    797: 'Nagaland', 798: 'Nagaland', 799: 'Tripura',
    810: 'Bihar', 811: 'Bihar', 812: 'Bihar', 813: 'Bihar', 821: 'Bihar', 823: 'Bihar', 824: 'Bihar',
    814: 'Jharkhand', 815: 'Jharkhand', 816: 'Jharkhand', 822: 'Jharkhand',
    825: 'Jharkhand', 826: 'Jharkhand', 827: 'Jharkhand', 828: 'Jharkhand', 829: 'Jharkhand',
};
// Shared by two states or territories (Chandigarh and Mohali; Uttar Pradesh
// and Uttarakhand; Gujarat and Daman, Diu, Dadra and Nagar Haveli; Puducherry's
// enclaves; Lakshadweep and Kochi) — the digits alone cannot say which, so the
// offline guess says nothing rather than something wrong.
const PIN3_MIXED = new Set([160, 244, 246, 247, 262, 362, 396, 533, 605, 607, 609, 673, 682]);

const isPincode = (v) => /^[1-9]\d{5}$/.test(String(v || '').trim());

const stateFromPincode = (pin) => {
    if (!isPincode(pin)) return '';
    const p = String(pin).trim();
    const p3 = Number(p.slice(0, 3));
    if (PIN3_MIXED.has(p3)) return '';
    const state = PIN3_STATE[p3] || PIN_PREFIX_STATE[Number(p.slice(0, 2))] || '';
    return STATES_AND_UTS.includes(state) ? state : '';
};

module.exports = { STATES, UNION_TERRITORIES, STATES_AND_UTS, PIN_PREFIX_STATE, PIN3_STATE, isPincode, stateFromPincode };
