import {createRequire} from 'node:module';
import {resolve} from 'node:path';
const require=createRequire(resolve('default-seed/package.json'));
const {chromium}=require('@playwright/test');
const launch=chromium.launch.bind(chromium);
chromium.launch=options=>launch({...options,executablePath:'/usr/bin/chromium',args:[...(options?.args??[]),'--no-sandbox']});
