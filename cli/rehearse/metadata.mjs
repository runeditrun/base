// Mirrors platform install-metadata.ts (bbf6ca98); keep installation projection behavior aligned.
import {MANAGED_WORKFLOW, repositoryAutomation} from './automation.mjs'

/** The edition-authoring recipe; its local component paths must all be tracked for the seed's source check. */
export const RECIPE = 'edition.json'
/** Generated metadata is JSON: the recipe, and Base copy records and object proofs wherever a seed keeps them
 * (edition-authoring's default `base-copies.json`, or any `--record` file), recognised by shape rather than name. */
export const metadataCandidate = (path        ) => path.endsWith('.json')

const within = (name        , prefix        ) => name === prefix || name.startsWith(prefix + '/')
const encode = (value         ) => new TextEncoder().encode(JSON.stringify(value, null, 2) + '\n')
// Unreadable metadata (a merge conflict, a publisher defect) passes through unchanged for the seed's own check to report.
const parse = (bytes            ) => { try { return JSON.parse(new TextDecoder().decode(bytes)) } catch { return null } }

/** A Base copy record names each verbatim copy, and the seed's own verify checks every recorded file is on disk with
 * its recorded bytes. The installation's record drops removed automation (and rer-managed.yml when RER replaced it,
 * since its bytes are no longer Base's). Returns null when nothing changes, keeping the publisher's bytes. */
const copyRecord = (record     ) => record?.schemaVersion === 1 && Array.isArray(record.copies)
 && record.copies.every((copy     ) => typeof copy?.path === 'string' && copy.files && typeof copy.files === 'object')
const removedCopy = (name        , keptWorkflow         ) => repositoryAutomation(name) && !(keptWorkflow && name === MANAGED_WORKFLOW)

function installationCopyRecord(record     , keptWorkflow         )                    {
 if (!copyRecord(record)) return null
 let changed = false
 const copies = record.copies.flatMap((copy     ) => {
  const names = Object.keys(copy?.files ?? {}), kept = names.filter(name => !removedCopy(name, keptWorkflow))
  if (kept.length === names.length) return [copy]
  changed = true
  if (!kept.length) return []
  const pick = (map                        ) => Object.fromEntries(Object.entries(map).filter(([name]) => kept.includes(name)))
  return [{...copy, files: pick(copy.files), ...(copy.modes ? {modes: pick(copy.modes)} : {})}]
 })
 return changed ? encode({...record, copies}) : null
}

/** The recipe's local component paths (and their mappings) drop the automation RER removed; RER's entry stays. */
function installationRecipe(recipe     )                    {
 if (!Array.isArray(recipe?.components)) return null
 const removed = (path         ) => typeof path === 'string' && repositoryAutomation(path) && !within(MANAGED_WORKFLOW, path)
 let changed = false
 const components = recipe.components.map((component     ) => {
  const source = component?.source
  if (source?.kind !== 'local' || !Array.isArray(source.paths) || !source.paths.some(removed)) return component
  changed = true
  const paths = source.paths.filter((path         ) => !removed(path))
  const mappings = source.mappings?.filter((mapping     ) => typeof mapping?.path === 'string' && paths.some((path        ) => within(mapping.path, path)))
  return {...component, source: {...source, paths, ...(source.mappings ? {mappings} : {})}}
 })
 return changed ? encode({...recipe, components}) : null
}

/** Blob ids that only the dropped copy records name, from every metadata file given (non-records are ignored);
 * `blob` maps a publisher path to its blob id. A recorded copy's bytes equal its Base origin's (the seed's check
 * compares both), so these are the origin blobs a retained Base object proof holds only for dropped records. */
export function droppedCopyBlobs(files                      , blob                                      , keptWorkflow         )              {
 const dropped = new Set        (), named = new Set        ()
 for (const bytes of files) {
  const record = parse(bytes)
  if (copyRecord(record)) for (const copy of record.copies) for (const name of Object.keys(copy.files)) {
   const id = blob(name)
   if (id) (removedCopy(name, keptWorkflow) ? dropped : named).add(id)
  }
 }
 for (const id of named) dropped.delete(id)
 return dropped
}

/** A retained Base object proof (native Git objects by id, standing in for the Base repository) admits exactly the
 * objects its copy records require, so it drops the origin blobs of the dropped records. */
function installationObjectProof(proof     , dropped                     )                    {
 const objects = proof?.objects
 if (!dropped.size || !Array.isArray(proof?.revisions) || !objects || typeof objects !== 'object' || Array.isArray(objects)
  || !Object.keys(objects).every(id => /^[a-f0-9]{40}$/.test(id))) return null
 const kept = Object.entries(objects).filter(([id]) => !dropped.has(id))
 return kept.length === Object.keys(objects).length ? null : encode({...proof, objects: Object.fromEntries(kept)})
}

/** The installation's bytes for one publisher metadata file, or null when it stays as published. `keptWorkflow`:
 * the installation carries the publisher's own rer-managed.yml; `dropped`: droppedCopyBlobs of the same tree. */
export function installationMetadata(path        , bytes            , keptWorkflow         , dropped                      = new Set())                    {
 if (!metadataCandidate(path)) return null
 const value = parse(bytes)
 return path === RECIPE ? installationRecipe(value) : installationCopyRecord(value, keptWorkflow) ?? installationObjectProof(value, dropped)
}
