import assert from 'node:assert/strict';
import { browserJourney } from '../../scripts/qualification/browser.mjs';

export const startupRows = [['browser runtime failure is never a widget success and browser is closed', {}, async()=>{
 let closed=false;
 const chromium={launch:async()=>({newPage:async()=>({on(){},goto:async()=>{throw new Error('startup-failed');}}),close:async()=>{closed=true;}})};
 await assert.rejects(browserJourney({origin:'https://throwaway.example',owner:{projectId:'project-id'},password:'test-password'},chromium),/startup-failed/);
 assert(closed);
}]];
