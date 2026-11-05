// Synthetic input declaration for the maintained manifest-driven setup paths.
export const emailManifest = {
 schema:1,title:'Email setup',groups:[{id:'email',label:'Email setup'}],fields:[
  {name:'EMAIL_PROVIDER',label:'Email provider',kind:'select',required:true,default:'later',group:'email',options:[{value:'later',label:'Set up later'},{value:'cloudflare',label:'Cloudflare Email Sending'},{value:'resend',label:'Resend'},{value:'sendgrid',label:'SendGrid'},{value:'mailgun',label:'Mailgun'}]},
  {name:'EMAIL_FROM',label:'From address',kind:'email',required:true,group:'email',presentations:['cloudflare','resend','sendgrid','mailgun'].map(provider=>({when:{field:'EMAIL_PROVIDER',equals:provider},required:true}))},
  {name:'EMAIL_API_KEY',label:'Email API key',kind:'secret',input:'entered',ownerVisible:true,required:true,group:'email',presentations:['cloudflare','resend','sendgrid'].map(provider=>({when:{field:'EMAIL_PROVIDER',equals:provider},required:true}))},
  {name:'EMAIL_API_KEY_NAME',label:'Sending key name',help:'The name of the private sending key, never its value.',kind:'select',options:[{value:'MAILGUN_SENDING_KEY',label:'MAILGUN_SENDING_KEY'}],default:'MAILGUN_SENDING_KEY',required:true,group:'email',when:{field:'EMAIL_PROVIDER',equals:'mailgun'}},
  {name:'MAILGUN_DOMAIN',label:'Mailgun sending domain',kind:'text',required:true,group:'email',when:{field:'EMAIL_PROVIDER',equals:'mailgun'}},
  {name:'MAILGUN_REGION',label:'Mailgun region',kind:'select',options:[{value:'us',label:'US'},{value:'eu',label:'EU'}],default:'us',group:'email',when:{field:'EMAIL_PROVIDER',equals:'mailgun'}},
  {name:'MAILGUN_SENDING_KEY',label:'Mailgun domain sending key',help:'Use a domain sending key. The separate Mailgun Routes key cannot send.',kind:'secret',input:'entered',ownerVisible:true,required:true,group:'email',when:{field:'EMAIL_PROVIDER',equals:'mailgun'}},
 ],steps:[{type:'extension',id:'email'}],
};
