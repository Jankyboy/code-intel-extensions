import { merge } from 'ix/asynciterable'
import * as sourcegraph from 'sourcegraph'
import * as lsp from 'vscode-languageserver-protocol'
import { ReferencesProvider } from '../../providers'
import { concat, noopAsyncGenerator } from '../../util/ix'
import { convertLocations, convertProviderParameters, rewriteUris } from '../conversion'
import { Feature } from './feature'
import { reregisterOnChange } from './util'

export interface ReferencesFeatureOptions {
    externalReferencesProvider?: ReferencesProvider
}

export const referencesFeature: Feature<
    typeof lsp.ReferencesRequest.type,
    'referencesProvider',
    ReferencesFeatureOptions
> = {
    requestType: lsp.ReferencesRequest.type,
    capabilityName: 'referencesProvider',
    register: ({
        sourcegraph,
        connection,
        clientToServerURI,
        serverToClientURI,
        scopedDocumentSelector,
        providerWrapper,
        featureOptions,
    }) => {
        async function* localReferences(
            textDocument: sourcegraph.TextDocument,
            position: sourcegraph.Position,
            context: sourcegraph.ReferenceContext
        ): AsyncGenerator<sourcegraph.Location[] | null, void, undefined> {
            const parameters = convertProviderParameters(textDocument, position, clientToServerURI)
            const result = await connection.sendRequest(lsp.ReferencesRequest.type, { ...parameters, context })
            rewriteUris(result, serverToClientURI)
            yield convertLocations(result) || []
        }

        const references = (externalReferences: ReferencesProvider): ReferencesProvider =>
            // False positive: https://github.com/typescript-eslint/typescript-eslint/issues/1691
            // eslint-disable-next-line @typescript-eslint/require-await
            async function* (
                textDocument: sourcegraph.TextDocument,
                position: sourcegraph.Position,
                context: sourcegraph.ReferenceContext
            ): AsyncGenerator<sourcegraph.Location[] | null, void, undefined> {
                yield* concat(
                    merge(
                        localReferences(textDocument, position, context),
                        externalReferences(textDocument, position, context)
                    )
                )
            }

        return reregisterOnChange(
            featureOptions,
            ['externalReferencesProvider'],
            ({ externalReferencesProvider = noopAsyncGenerator }) =>
                sourcegraph.languages.registerReferenceProvider(
                    scopedDocumentSelector,
                    providerWrapper.references(references(externalReferencesProvider))
                )
        )
    },
}
