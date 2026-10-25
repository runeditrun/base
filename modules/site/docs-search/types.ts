export type SearchSection = { anchor: string; titlePath: string[]; text: string };
export type SearchPage = { href: string; searchSections: SearchSection[] };
export type SearchResult = { href: string; titlePath: string[]; snippet: string; score: number };
