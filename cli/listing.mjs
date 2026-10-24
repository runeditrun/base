import { writeListing } from '../modules/release/listing.mjs';
import { previousListing } from '../modules/release/previous-listing.mjs';

export async function dispatchListing(args) {
  if (args.includes('--help')) {
    console.log('Usage: rer listing --repo DIR --ref COMMIT --output NEW_DIR\n\nRead committed listing facts and assets without gates, signing or tags.\nWrites listing.json and its relative asset paths. --ref defaults to HEAD.');
    return 0;
  }
  try {
    const options = {};
    for (let index = 0; index < args.length; index++) {
      const flag = args[index];
      if (!['--repo', '--ref', '--output'].includes(flag) || options[flag.slice(2)] !== undefined || !args[index + 1] || args[index + 1].startsWith('--')) throw Error('Invalid listing arguments');
      options[flag.slice(2)] = args[++index];
    }
    if (!options.repo || !options.output) throw Error('Listing requires --repo and --output');
    console.log(JSON.stringify(writeListing(options, previousListing), null, 2));
    return 0;
  } catch (error) { console.error(error.message); return 2; }
}
