import * as assert from 'assert'
import * as sinon from 'sinon'
import * as sourcegraph from 'sourcegraph'
import {
    calculateRangeWindow,
    rangesInRangeWindow,
    findOverlappingWindows,
    RangesResponse,
    findOverlappingCodeIntelligenceRange,
} from './ranges'
import { range1, makeEnvelope, range2, range3, textDocument, makeResource, position } from './util.test'
import { QueryGraphQLFn } from '../util/graphql'
import { GenericLSIFResponse } from './api'

describe('findOverlappingWindows', () => {
    const aggregate1 = { range: range1 }
    const aggregate2 = { range: range2 }
    const aggregate3 = { range: range3 }

    it('finds overlapping ranges', async () => {
        const windows = [
            { startLine: 1, endLine: 3, ranges: Promise.resolve([aggregate1]) },
            { startLine: 4, endLine: 6, ranges: Promise.resolve([aggregate2]) },
            { startLine: 7, endLine: 9, ranges: Promise.resolve([aggregate3]) },
        ]

        assert.deepEqual(await findOverlappingWindows(textDocument, position, windows), [aggregate2])
    })

    it('creates new window and inserts it correctly', async () => {
        const queryGraphQLFn = sinon.spy<QueryGraphQLFn<GenericLSIFResponse<RangesResponse | null>>>(() =>
            makeEnvelope({ ranges: { nodes: [{ range: range2 }] } })
        )

        const windows = [
            { startLine: 1, endLine: 3, ranges: Promise.resolve([aggregate1]) },
            { startLine: 4, endLine: 6, ranges: Promise.resolve([aggregate2]) },
            { startLine: 7, endLine: 9, ranges: Promise.resolve([aggregate3]) },
        ]

        assert.deepEqual(await findOverlappingWindows(textDocument, position, windows, queryGraphQLFn), [aggregate2])
        assert.equal(windows.length, 3)
        assert.equal(windows[1].startLine, 4)
        assert.equal(windows[1].endLine, 6)
        assert.deepEqual(await windows[0].ranges, [aggregate1])
        assert.deepEqual(await windows[1].ranges, [aggregate2])
        assert.deepEqual(await windows[2].ranges, [aggregate3])
    })
})

describe('calculateRangeWindow', () => {
    it('centers window around line', () => {
        assert.deepEqual(calculateRangeWindow(200, 0, undefined), [150, 250])
    })

    it('respects lower and upper bounds', () => {
        assert.deepEqual(calculateRangeWindow(200, 175, 225), [175, 225])
    })

    it('gives upper slack to start line', () => {
        assert.deepEqual(calculateRangeWindow(200, 0, 225), [125, 225])
        assert.deepEqual(calculateRangeWindow(200, 140, 225), [140, 225])
    })

    it('gives lower slack to end line', () => {
        assert.deepEqual(calculateRangeWindow(200, 175, undefined), [175, 275])
        assert.deepEqual(calculateRangeWindow(200, 175, 260), [175, 260])
    })
})

describe('findOverlappingCodeIntelligenceRange', () => {
    it('checks singe line overlap', () => {
        const range = { range: new sourcegraph.Range(10, 5, 10, 7) }

        const overlappingPositions = [new sourcegraph.Position(10, 5), new sourcegraph.Position(10, 6)]

        for (const position of overlappingPositions) {
            assert.equal(findOverlappingCodeIntelligenceRange(position, [range]), range)
        }

        const disjointPositions = [
            new sourcegraph.Position(9, 1), // before start line
            new sourcegraph.Position(10, 4), // before
            new sourcegraph.Position(10, 7), // on right edge
            new sourcegraph.Position(10, 8), // after
            new sourcegraph.Position(11, 1), // after end line
        ]

        for (const position of disjointPositions) {
            assert.equal(findOverlappingCodeIntelligenceRange(position, [range]), null)
        }
    })

    it('checks multi line overlap', () => {
        const range = { range: new sourcegraph.Range(10, 5, 12, 7) }

        const overlappingPositions = [
            new sourcegraph.Position(11, 4), // inner line
            new sourcegraph.Position(11, 6), // inner line
            new sourcegraph.Position(11, 8), // inner line
            new sourcegraph.Position(10, 6), // start line (inside range)
            new sourcegraph.Position(12, 6), // end line (inside range)
        ]

        for (const position of overlappingPositions) {
            assert.equal(findOverlappingCodeIntelligenceRange(position, [range]), range)
        }

        const disjointPositions = [
            new sourcegraph.Position(9, 1), // before start line
            new sourcegraph.Position(10, 4), // on start line (before)
            new sourcegraph.Position(12, 8), // on end line
            new sourcegraph.Position(13, 1), // after end line
        ]

        for (const position of disjointPositions) {
            assert.equal(findOverlappingCodeIntelligenceRange(position, [range]), null)
        }
    })

    it('returns the inner-most range', () => {
        const ranges = [
            { range: new sourcegraph.Range(1, 0, 5, 10) },
            { range: new sourcegraph.Range(2, 0, 4, 10) },
            { range: new sourcegraph.Range(3, 2, 3, 8) },
            { range: new sourcegraph.Range(3, 4, 3, 6) },
        ]

        const position = new sourcegraph.Position(3, 5)
        assert.equal(findOverlappingCodeIntelligenceRange(position, ranges), ranges[3])
    })
})

describe('rangesInRangeWindow', () => {
    it('should correctly parse result', async () => {
        const queryGraphQLFn = sinon.spy<QueryGraphQLFn<GenericLSIFResponse<RangesResponse | null>>>(() =>
            makeEnvelope({
                ranges: {
                    nodes: [
                        {
                            range: range1,
                            definitions: {
                                nodes: [
                                    {
                                        resource: makeResource('repo', 'rev', '/bar.ts'),
                                        range: range2,
                                    },
                                ],
                            },
                            references: {
                                nodes: [
                                    {
                                        resource: makeResource('repo', 'rev', '/baz.ts'),
                                        range: range3,
                                    },
                                ],
                            },
                            hover: {
                                markdown: {
                                    text: 'foo',
                                },
                                range: range1,
                            },
                        },
                    ],
                },
            })
        )

        assert.deepEqual(await rangesInRangeWindow(textDocument, 10, 20, queryGraphQLFn), [
            {
                range: range1,
                definitions: [new sourcegraph.Location(new URL('git://repo?rev#/bar.ts'), range2)],
                references: [new sourcegraph.Location(new URL('git://repo?rev#/baz.ts'), range3)],
                hover: {
                    markdown: {
                        text: 'foo',
                    },
                    range: range1,
                },
            },
        ])
    })

    it('should deal with empty payload', async () => {
        const queryGraphQLFn = sinon.spy<QueryGraphQLFn<GenericLSIFResponse<RangesResponse | null>>>(() =>
            makeEnvelope()
        )

        assert.deepStrictEqual(await rangesInRangeWindow(textDocument, 10, 20, queryGraphQLFn), null)
    })
})
