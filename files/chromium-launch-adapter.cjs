const {createRequire} = require('node:module');
const {join} = require('node:path');
const requireSeed = createRequire(join(process.env.RER_BROWSER_BASE, 'default-seed/package.json'));
const {chromium} = requireSeed('@playwright/test');
const launch = chromium.launch.bind(chromium);
chromium.launch = (options = {}) => launch({...options, executablePath:'/usr/bin/chromium', args:[...(options.args ?? []), '--no-sandbox']});
