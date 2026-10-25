import {fullCaseFold} from './case-folding.mjs';

// Each path component has one portable identity, for every plan operation and
// filesystem spelling check. Normalize again because full folds may decompose.
export const destinationKey = name => name.split('/').map(part => fullCaseFold(part.normalize('NFC')).normalize('NFC')).join('/');
