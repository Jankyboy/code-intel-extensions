import { NEVER, Observable } from 'rxjs'
import * as sourcegraph from 'sourcegraph'
import { impreciseBadge } from './badges'
import { LanguageSpec, LSIFSupport } from './language-specs/spec'
import { Logger } from './logging'
import { createProviders as createLSIFProviders } from './lsif/providers'
import { createProviders as createSearchProviders } from './search/providers'
import { TelemetryEmitter } from './telemetry'
import { asArray, mapArrayish, nonEmpty } from './util/helpers'
import { noopAsyncGenerator, observableFromAsyncIterator } from './util/ix'
import * as HoverAlerts from './hover-alerts'

export interface Providers {
    definition: DefinitionProvider
    references: ReferencesProvider
    hover: HoverProvider
    documentHighlights: DocumentHighlightProvider
}

export interface CombinedProviders {
    definitionAndHover: DefinitionAndHoverProvider
    references: ReferencesProvider
    documentHighlights: DocumentHighlightProvider
}

export interface SourcegraphProviders {
    definition: sourcegraph.DefinitionProvider
    references: sourcegraph.ReferenceProvider
    hover: sourcegraph.HoverProvider
    documentHighlights: sourcegraph.DocumentHighlightProvider
}

export interface DefinitionAndHover {
    definition: sourcegraph.Definition | null
    hover: sourcegraph.Hover | null
}

export type DefinitionAndHoverProvider = (
    doc: sourcegraph.TextDocument,
    pos: sourcegraph.Position
) => Promise<DefinitionAndHover | null>

export type DefinitionProvider = (
    doc: sourcegraph.TextDocument,
    pos: sourcegraph.Position
) => AsyncGenerator<sourcegraph.Definition, void, undefined>

export type ReferencesProvider = (
    doc: sourcegraph.TextDocument,
    pos: sourcegraph.Position,
    context: sourcegraph.ReferenceContext
) => AsyncGenerator<sourcegraph.Location[] | null, void, undefined>

export type HoverProvider = (
    doc: sourcegraph.TextDocument,
    pos: sourcegraph.Position
) => AsyncGenerator<sourcegraph.Hover | null, void, undefined>

export type DocumentHighlightProvider = (
    doc: sourcegraph.TextDocument,
    pos: sourcegraph.Position
) => AsyncGenerator<sourcegraph.DocumentHighlight[] | null, void, undefined>

export const noopProviders = {
    definitionAndHover: (): Promise<DefinitionAndHover | null> => Promise.resolve(null),
    definition: noopAsyncGenerator,
    references: noopAsyncGenerator,
    hover: noopAsyncGenerator,
    documentHighlights: noopAsyncGenerator,
}

export interface ProviderWrapper {
    definition: DefinitionWrapper
    references: ReferencesWrapper
    hover: HoverWrapper
    documentHighlights: DocumentHighlightWrapper
}

export type DefinitionWrapper = (provider?: DefinitionProvider) => sourcegraph.DefinitionProvider

export type ReferencesWrapper = (provider?: ReferencesProvider) => sourcegraph.ReferenceProvider

export type HoverWrapper = (provider?: HoverProvider) => sourcegraph.HoverProvider

export type DocumentHighlightWrapper = (provider?: DocumentHighlightProvider) => sourcegraph.DocumentHighlightProvider

export class NoopProviderWrapper implements ProviderWrapper {
    public definition = (provider?: DefinitionProvider): sourcegraph.DefinitionProvider => ({
        provideDefinition: (textDocument: sourcegraph.TextDocument, position: sourcegraph.Position) =>
            provider ? observableFromAsyncIterator(() => provider(textDocument, position)) : NEVER,
    })

    public references = (provider?: ReferencesProvider): sourcegraph.ReferenceProvider => ({
        provideReferences: (
            textDocument: sourcegraph.TextDocument,
            position: sourcegraph.Position,
            context: sourcegraph.ReferenceContext
        ) => (provider ? observableFromAsyncIterator(() => provider(textDocument, position, context)) : NEVER),
    })

    public hover = (provider?: HoverProvider): sourcegraph.HoverProvider => ({
        provideHover: (textDocument: sourcegraph.TextDocument, position: sourcegraph.Position) =>
            provider ? observableFromAsyncIterator(() => provider(textDocument, position)) : NEVER,
    })

    public documentHighlights = (provider?: DocumentHighlightProvider): sourcegraph.DocumentHighlightProvider => ({
        provideDocumentHighlights: (textDocument: sourcegraph.TextDocument, position: sourcegraph.Position) =>
            provider ? observableFromAsyncIterator(() => provider(textDocument, position)) : NEVER,
    })
}

/**
 * Creates a provider wrapper that decorates a given provider with LSIF and search-based behaviors.
 *
 * @param languageSpec The language spec used to provide search-based code intelligence.
 */
export function createProviderWrapper(languageSpec: LanguageSpec, logger: Logger): ProviderWrapper {
    // Create empty wrapped providers. Each provider will update the
    // appropriate field when they are fully wrapped, so this object
    // always has the "active" providers.
    const wrapped: Partial<SourcegraphProviders> = {}

    const lsifProviders = createLSIFProviders(logger)
    const searchProviders = createSearchProviders(languageSpec, wrapped)

    return {
        definition: (lspProvider?: DefinitionProvider) => {
            const provider = createDefinitionProvider(
                lsifProviders.definitionAndHover,
                searchProviders.definition,
                lspProvider
            )
            wrapped.definition = provider
            return provider
        },

        references: (lspProvider?: ReferencesProvider) => {
            const provider = createReferencesProvider(lsifProviders.references, searchProviders.references, lspProvider)
            wrapped.references = provider
            return provider
        },

        hover: (lspProvider?: HoverProvider) => {
            const provider = createHoverProvider(
                languageSpec.lsifSupport || LSIFSupport.None,
                lsifProviders.definitionAndHover,
                searchProviders.definition,
                searchProviders.hover,
                lspProvider
            )
            wrapped.hover = provider
            return provider
        },

        documentHighlights: (lspProvider?: DocumentHighlightProvider) => {
            const provider = createDocumentHighlightProvider(
                lsifProviders.documentHighlights,
                searchProviders.documentHighlights,
                lspProvider
            )
            wrapped.documentHighlights = provider
            return provider
        },
    }
}

/**
 * Creates a definition provider.
 *
 * @param lsifProvider The LSIF-based definition and hover provider.
 * @param searchProvider The search-based definition provider.
 * @param lspProvider An optional LSP-based definition provider.
 */
export function createDefinitionProvider(
    lsifProvider: DefinitionAndHoverProvider,
    searchProvider: DefinitionProvider,
    lspProvider?: DefinitionProvider
): sourcegraph.DefinitionProvider {
    return {
        provideDefinition: wrapProvider(async function* (
            textDocument: sourcegraph.TextDocument,
            position: sourcegraph.Position
        ): AsyncGenerator<sourcegraph.Definition | undefined, void, undefined> {
            const emitter = new TelemetryEmitter()

            let hasPreciseResult = false
            const lsifWrapper = await lsifProvider(textDocument, position)
            if (lsifWrapper) {
                for await (const lsifResult of asArray(lsifWrapper.definition || [])) {
                    await emitter.emitOnce('lsifDefinitions')
                    yield lsifResult
                    hasPreciseResult = true
                }
            }
            if (hasPreciseResult) {
                // Found the best precise definition we'll get. Stop.
                return
            }

            if (lspProvider) {
                for await (const lspResult of lspProvider(textDocument, position)) {
                    if (nonEmpty(lspResult)) {
                        // Do not emit definition events for empty location arrays
                        await emitter.emitOnce('lspDefinitions')
                    }

                    // Always emit the result regardless if it's interesting. If we return
                    // without emitting anything here we may indefinitely show an empty hover
                    // on identifiers with no interesting data indefinitely.
                    yield lspResult
                }

                // Do not try to supplement with additional search results as we have all the
                // context we need for complete and precise results here.
                return
            }

            // No results so far, fall back to search
            for await (const searchResult of searchProvider(textDocument, position)) {
                if (nonEmpty(searchResult)) {
                    await emitter.emitOnce('searchDefinitions')
                }

                // Mark the result as imprecise
                yield badgeValues(searchResult, impreciseBadge)
            }
        }),
    }
}

/** Gets an opaque value that is the same for all locations within a file but different from other files. */
const file = (location_: sourcegraph.Location): string =>
    `${location_.uri.host} ${location_.uri.pathname} ${location_.uri.hash}`

/**
 * Creates a reference provider.
 *
 * @param lsifProvider The LSIF-based references provider.
 * @param searchProvider The search-based references provider.
 * @param lspProvider An optional LSP-based references provider.
 */
export function createReferencesProvider(
    lsifProvider: ReferencesProvider,
    searchProvider: ReferencesProvider,
    lspProvider?: ReferencesProvider
): sourcegraph.ReferenceProvider {
    return {
        provideReferences: wrapProvider(async function* (
            textDocument: sourcegraph.TextDocument,
            position: sourcegraph.Position,
            context: sourcegraph.ReferenceContext
        ): AsyncGenerator<sourcegraph.Location[] | null, void, undefined> {
            const emitter = new TelemetryEmitter()

            let lsifResults: sourcegraph.Location[] = []
            for await (const lsifResult of lsifProvider(textDocument, position, context)) {
                if (nonEmpty(lsifResult)) {
                    await emitter.emitOnce('lsifReferences')
                    yield lsifResult
                    lsifResults = lsifResult
                }
            }

            if (lspProvider) {
                for await (const lspResult of lspProvider(textDocument, position, context)) {
                    // TODO - reduce duplicates between LSIF and LSP
                    const filteredResults = asArray(lspResult)
                    if (filteredResults.length === 0) {
                        continue
                    }

                    // Re-emit the last results from the previous provider
                    // so we do not overwrite what was emitted previously.
                    await emitter.emitOnce('lspReferences')
                    yield lsifResults.concat(filteredResults)
                }

                // Do not try to supplement with additional search results
                // as we have all the context we need for complete and precise
                // results here.
                return
            }

            const lsifFiles = new Set(lsifResults.map(file))

            for await (const searchResult of searchProvider(textDocument, position, context)) {
                // Filter out any search results that occur in the same file
                // as LSIF results. These results are definitely incorrect and
                // will pollute the ordering of precise and fuzzy results in
                // the references pane.
                const filteredResults = asArray(searchResult).filter(location => !lsifFiles.has(file(location)))
                if (filteredResults.length === 0) {
                    continue
                }

                // Re-emit the last results from the previous provider so we
                // do not overwrite what was emitted previously. Mark new results
                // as imprecise.
                await emitter.emitOnce('searchReferences')
                yield lsifResults.concat(asArray(badgeValues(filteredResults, impreciseBadge)))
            }
        }),
    }
}

/**
 * Creates a hover provider.
 *
 * @param lsifProvider The LSIF-based definition and hover provider.
 * @param searchDefinitionProvider The search-based definition provider.
 * @param searchHoverProvider The search-based hover provider.
 * @param lspProvider An optional LSP-based hover provider.
 */
export function createHoverProvider(
    lsifSupport: LSIFSupport,
    lsifProvider: DefinitionAndHoverProvider,
    searchDefinitionProvider: DefinitionProvider,
    searchHoverProvider: HoverProvider,
    lspProvider?: HoverProvider
): sourcegraph.HoverProvider {
    const searchAlerts =
        lsifSupport === LSIFSupport.None
            ? [HoverAlerts.searchLSIFSupportNone]
            : lsifSupport === LSIFSupport.Experimental
            ? [HoverAlerts.searchLSIFSupportExperimental]
            : lsifSupport === LSIFSupport.Robust
            ? [HoverAlerts.searchLSIFSupportRobust]
            : undefined

    return {
        provideHover: wrapProvider(async function* (
            textDocument: sourcegraph.TextDocument,
            position: sourcegraph.Position
        ): AsyncGenerator<sourcegraph.Badged<sourcegraph.Hover> | null | undefined, void, undefined> {
            const emitter = new TelemetryEmitter()
            let hasPreciseDefinition = false

            const lsifWrapper = await lsifProvider(textDocument, position)
            if (lsifWrapper) {
                if (lsifWrapper.hover) {
                    let partialPreciseData = false
                    if (!nonEmpty(lsifWrapper.definition)) {
                        for await (const searchResult of searchDefinitionProvider(textDocument, position)) {
                            if (nonEmpty(searchResult)) {
                                partialPreciseData = true
                                break
                            }
                        }
                    }

                    // Display a partial data tooltip when there is a precise hover
                    // text but a search definition. This can happen if we haven't
                    // indexed the target repository.
                    const alerts = !partialPreciseData ? [HoverAlerts.lsif] : [HoverAlerts.lsifPartialHoverOnly]

                    // Found the best precise hover text we'll get. Stop.
                    await emitter.emitOnce('lsifHover')
                    yield { ...lsifWrapper.hover, alerts }
                    return
                }

                if (nonEmpty(lsifWrapper.definition)) {
                    hasPreciseDefinition = true
                }
            }

            if (lspProvider) {
                let alerts: sourcegraph.Badged<sourcegraph.HoverAlert>[] | undefined = [HoverAlerts.lsp]
                for await (const lspResult of lspProvider(textDocument, position)) {
                    if (lspResult) {
                        // Delegate to LSP if it's available.
                        await emitter.emitOnce('lspHover')
                        yield { ...lspResult, ...(alerts ? { alerts } : {}) }
                        alerts = undefined
                    }
                }

                // Do not try to supplement with additional search results
                // as we have all the context we need for complete and precise
                // results here.
                return
            }

            let alerts = hasPreciseDefinition ? [HoverAlerts.lsifPartialDefinitionOnly] : searchAlerts

            for await (const searchResult of searchHoverProvider(textDocument, position)) {
                if (searchResult) {
                    // No results so far, fall back to search. Mark the result as imprecise.
                    await emitter.emitOnce('searchHover')
                    yield { ...searchResult, ...(alerts ? { alerts } : {}) }
                    alerts = undefined
                }
            }
        }),
    }
}

/**
 * Creates a document highlight provider.
 *
 * @param lsifProvider The LSIF-based document highlight provider.
 * @param searchProvider The search-based document highlight provider.
 * @param lspProvider An optional LSP-based document highlight provider.
 */
export function createDocumentHighlightProvider(
    lsifProvider: DocumentHighlightProvider,
    searchProvider: DocumentHighlightProvider,
    lspProvider?: DocumentHighlightProvider
): sourcegraph.DocumentHighlightProvider {
    return {
        provideDocumentHighlights: wrapProvider(async function* (
            textDocument: sourcegraph.TextDocument,
            position: sourcegraph.Position
        ): AsyncGenerator<sourcegraph.DocumentHighlight[] | null | undefined, void, undefined> {
            const emitter = new TelemetryEmitter()

            for await (const lsifResult of lsifProvider(textDocument, position)) {
                if (lsifResult) {
                    await emitter.emitOnce('lsifDocumentHighlight')
                    yield lsifResult
                }
            }
        }),
    }
}

/**
 * Add a badge property to a single value or to a list of values. Returns the
 * modified result in the same shape as the input.
 *
 * @param value The list of values, a single value, or null.
 * @param badge The badge attachment.
 */
export function badgeValues<T extends object>(
    value: T | T[] | null,
    badge: sourcegraph.BadgeAttachmentRenderOptions
): sourcegraph.Badged<T> | sourcegraph.Badged<T>[] | null {
    return mapArrayish(value, element => ({ ...element, badge }))
}

/**
 * Converts an async generator provider into an observable provider.
 *
 * @param func A function that returns a the provider.
 */
function wrapProvider<P extends unknown[], R>(
    func: (...args: P) => AsyncGenerator<R, void, void>
): (...args: P) => Observable<R> {
    return (...args) => observableFromAsyncIterator(() => func(...args))
}
