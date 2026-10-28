// Keep the credential link only where the caller already permits openUrl.
export function readySummary({ url, openUrl, signedInAs, siteUrl }) {
 const lines = [openUrl
  ? `Open your app${signedInAs ? ', already signed in' : ''} on this computer: ${openUrl}`
  : `Open your app on this computer: ${url}`];
 if (siteUrl) lines.push(`Help and public site preview (secondary): ${siteUrl}`);
 if (openUrl) lines.push(`App address (without sign-in): ${url}`, 'Keep the sign-in link private.');
 return lines;
}
