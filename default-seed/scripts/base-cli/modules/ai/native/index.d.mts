export interface NativeAiRequest {
 schema: 1; provider: 'cloudflare'; transport: 'native'; binding: string; budgetBinding: string; imageBinding: string;
 textModels: string[]; imageModels: string[]; purposes: Array<{id:string;kind:'text'|'image';model:string}>;
 limits: {calls:number;units:number;microUsd:number};
 operations: {textCalls:2;maxInputBytes:number;maxOutputTokens:number;imageUnits:number;timeoutMs:number};
}
export interface NativeAiAuthority {
 schema:1; enabled:boolean; accountId:string; sourceSha:string; installation:string; environment:string; tenant:string; revision:string; custody:string;
 permitted:NativeAiRequest;
 prices:Record<string,{version:string;validUntil:number;inputMicroUsdPerMillion:number;outputMicroUsdPerMillion:number;imageMicroUsdPerUnit:number}>;
 proofs:Record<string,{reference:string;kind:'text'|'image';maxInputTokens:number;maxOutputTokens:number;maxImageUnits:number;mime:string}>;
}
export function createNativeAiConsumer(options:{
 env:object; auth:{getSession(request:Request):Promise<unknown>};origin:string;request:NativeAiRequest;authority:NativeAiAuthority;
 mode?:'disabled'|'owner-account'|'managed'|'assisted'|'dev'|'demo';
 prepareSecond?:(first:string,original:string)=>Promise<string|null>|string|null;
}):{handle(request:Request):Promise<Response>};
export class AiAuthority {
 constructor(ctx:DurableObjectState,env:Record<string,unknown>);
 fetch(request:Request):Promise<Response>;
}
