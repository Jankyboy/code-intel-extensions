import { extname } from 'path'
import * as sourcegraph from 'sourcegraph'
import { parseGitURI } from '../util/uri'

/**
 * Create a search query to find definitions of a symbol.
 *
 * @param args Parameter bag.
 */
export function definitionQuery({
    searchToken,
    doc,
    fileExts,
}: {
    /** The search token text. */
    searchToken: string
    /** The current text document. */
    doc: sourcegraph.TextDocument
    /** File extensions used by the current extension. */
    fileExts: string[]
}): string[] {
    const { path } = parseGitURI(new URL(doc.uri))

    return [`^${searchToken}$`, 'type:symbol', 'patternType:regexp', 'case:yes', fileExtensionTerm(path, fileExts)]
}

/**
 * Create a search query to find references of a symbol.
 *
 * @param args Parameter bag.
 */
export function referencesQuery({
    searchToken,
    doc,
    fileExts,
}: {
    /** The search token text. */
    searchToken: string
    /** The current text document. */
    doc: sourcegraph.TextDocument
    /** File extensions used by the current extension. */
    fileExts: string[]
}): string[] {
    const { path } = parseGitURI(new URL(doc.uri))

    return [`\\b${searchToken}\\b`, 'type:file', 'patternType:regexp', 'case:yes', fileExtensionTerm(path, fileExts)]
}

const excludelist = new Set(['thrift', 'proto', 'graphql'])

/**
 * Constructs a file extension term (or an empty string) if the current file end
 * in one of the extensions for the current language and does NOT end in one of
 * the excluded files defined above.
 *
 * @param path The path of the current text file.
 * @param includelist The file extensions for the current language.
 */
function fileExtensionTerm(path: string, includelist: string[]): string {
    const extension = extname(path).slice(1)
    if (!extension || excludelist.has(extension) || !includelist.includes(extension)) {
        return ''
    }

    return `file:\\.(${includelist.join('|')})$`
}
