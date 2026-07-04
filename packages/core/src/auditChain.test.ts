import { describe, expect, it } from 'vitest';
import {
  AUDIT_CHAIN_GENESIS_PREV_HASH,
  canonicalizeAuditPayload,
  computeEventHash,
  verifyAuditChain,
  type AuditEventFields,
  type StoredAuditEvent,
} from './auditChain';

// Trivial, deterministic, synchronous, hex-output stub -- NOT cryptographic.
// Standing in for packages/data's real SHA-256 (node:crypto), per this
// module's HashFn contract: core never imports node:crypto (CLAUDE.md §2).
function stubHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (Math.imul(31, hash) + input.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function baseFields(overrides: Partial<AuditEventFields> = {}): AuditEventFields {
  return {
    ts: 1_781_000_000_000,
    actor: 'admin@example.com',
    action: 'budget.create',
    entityRef: 'budget:universal:acme-enterprise',
    trigger: 'manual',
    envelopeSnapshot: null,
    before: null,
    after: JSON.stringify({ amountCredits: 4000 }),
    justification: null,
    dataSnapshotId: 42,
    ...overrides,
  };
}

function appendToChain(chain: readonly StoredAuditEvent[], fields: AuditEventFields): StoredAuditEvent {
  const last = chain[chain.length - 1];
  const prevHash = last ? last.hash : AUDIT_CHAIN_GENESIS_PREV_HASH;
  const hash = computeEventHash(prevHash, canonicalizeAuditPayload(fields), stubHash);
  return { ...fields, prevHash, hash };
}

// A 4-event chain touching every field shape at least once: null vs
// populated envelopeSnapshot/before/after, differing actors/actions/triggers.
function buildChain(): [StoredAuditEvent, StoredAuditEvent, StoredAuditEvent, StoredAuditEvent] {
  const chain: StoredAuditEvent[] = [];

  const e0 = appendToChain(
    chain,
    baseFields({ action: 'budget.create', entityRef: 'budget:universal:acme-enterprise' }),
  );
  chain.push(e0);

  const e1 = appendToChain(
    chain,
    baseFields({
      action: 'budget.update',
      entityRef: 'budget:individual:user-07',
      before: JSON.stringify({ amountCredits: 4000 }),
      after: JSON.stringify({ amountCredits: 5000 }),
      justification: 'manager-approved increase',
    }),
  );
  chain.push(e1);

  const e2 = appendToChain(
    chain,
    baseFields({
      actor: 'system:pool-rebalancer',
      action: 'included_cap.update',
      entityRef: 'included_cap:Platform',
      trigger: 'pool_rebalancer',
      envelopeSnapshot: JSON.stringify({ envelopeCredits: 1200, bindingConstraint: 'included_cap' }),
      before: JSON.stringify({ enabled: true, overflow: 'block' }),
      after: JSON.stringify({ enabled: true, overflow: 'metered' }),
      dataSnapshotId: 43,
    }),
  );
  chain.push(e2);

  const e3 = appendToChain(
    chain,
    baseFields({
      action: 'budget.delete',
      entityRef: 'budget:individual:user-16',
      before: JSON.stringify({ amountCredits: 100 }),
      after: null,
    }),
  );
  chain.push(e3);

  return [e0, e1, e2, e3];
}

function tamper(chain: readonly StoredAuditEvent[], index: number, patch: Partial<StoredAuditEvent>): StoredAuditEvent[] {
  return chain.map((event, i) => (i === index ? { ...event, ...patch } : event));
}

describe('canonicalizeAuditPayload', () => {
  it('is deterministic for identical fields', () => {
    const fields = baseFields();
    expect(canonicalizeAuditPayload(fields)).toBe(canonicalizeAuditPayload({ ...fields }));
  });

  it('produces a distinct payload when any single field differs', () => {
    const fields = baseFields();
    const changedOneField: Array<Partial<AuditEventFields>> = [
      { ts: fields.ts + 1 },
      { actor: 'someone-else' },
      { action: 'budget.delete' },
      { entityRef: 'budget:universal:other-enterprise' },
      { trigger: 'metered_rebalancer' },
      { envelopeSnapshot: JSON.stringify({ x: 1 }) },
      { before: JSON.stringify({ x: 1 }) },
      { after: JSON.stringify({ x: 1 }) },
      { justification: 'because' },
      { dataSnapshotId: 999 },
    ];
    const basePayload = canonicalizeAuditPayload(fields);
    for (const patch of changedOneField) {
      expect(canonicalizeAuditPayload({ ...fields, ...patch })).not.toBe(basePayload);
    }
  });

  it('is not affected by extra/reordered object properties (array encoding, not object)', () => {
    const fields = baseFields();
    // Constructing the same logical fields via a different property-insertion
    // order (a plausible future-refactor scenario) must serialize identically,
    // because canonicalizeAuditPayload reads named fields into a fixed-order
    // array rather than depending on `fields`'s own key order.
    const reorderedConstruction: AuditEventFields = {
      dataSnapshotId: fields.dataSnapshotId,
      justification: fields.justification,
      after: fields.after,
      before: fields.before,
      envelopeSnapshot: fields.envelopeSnapshot,
      trigger: fields.trigger,
      entityRef: fields.entityRef,
      action: fields.action,
      actor: fields.actor,
      ts: fields.ts,
    };
    expect(canonicalizeAuditPayload(reorderedConstruction)).toBe(canonicalizeAuditPayload(fields));
  });
});

describe('computeEventHash', () => {
  it('is deterministic for identical inputs', () => {
    const payload = canonicalizeAuditPayload(baseFields());
    expect(computeEventHash(AUDIT_CHAIN_GENESIS_PREV_HASH, payload, stubHash)).toBe(
      computeEventHash(AUDIT_CHAIN_GENESIS_PREV_HASH, payload, stubHash),
    );
  });

  it('changes when prevHash changes but payload does not', () => {
    const payload = canonicalizeAuditPayload(baseFields());
    expect(computeEventHash('hash-a', payload, stubHash)).not.toBe(computeEventHash('hash-b', payload, stubHash));
  });
});

describe('verifyAuditChain', () => {
  it('verifies an empty chain (vacuously)', () => {
    expect(verifyAuditChain([], stubHash)).toEqual({ ok: true });
  });

  it('verifies a clean N-event chain', () => {
    const chain = buildChain();
    expect(verifyAuditChain(chain, stubHash)).toEqual({ ok: true });
  });

  it('rejects a first event whose prevHash is not the genesis sentinel', () => {
    const chain = buildChain();
    const tampered = tamper(chain, 0, { prevHash: 'not-genesis' });
    const result = verifyAuditChain(tampered, stubHash);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failedAtIndex).toBe(0);
  });

  it('detects reordering of two middle events', () => {
    const [e0, e1, e2, e3] = buildChain();
    const reordered = [e0, e2, e1, e3];
    const result = verifyAuditChain(reordered, stubHash);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failedAtIndex).toBe(1);
  });

  it('detects deletion of a middle event', () => {
    const [e0, e1, e2, e3] = buildChain();
    void e1;
    const withoutMiddle = [e0, e2, e3];
    const result = verifyAuditChain(withoutMiddle, stubHash);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failedAtIndex).toBe(1);
  });

  // Tamper matrix: mutating ANY single field of ANY event -- including
  // prevHash and hash themselves -- must break verification, and must break
  // it AT THE TAMPERED EVENT'S OWN INDEX (index 2 of 4, a genuine "middle"
  // event with both a predecessor and a successor).
  const TAMPER_CASES: Array<[string, Partial<StoredAuditEvent>]> = [
    ['ts', { ts: 999 }],
    ['actor', { actor: 'forged-actor' }],
    ['action', { action: 'budget.delete' }],
    ['entityRef', { entityRef: 'included_cap:Other' }],
    ['trigger', { trigger: 'manual' }],
    ['envelopeSnapshot', { envelopeSnapshot: JSON.stringify({ envelopeCredits: 999999 }) }],
    ['before', { before: JSON.stringify({ enabled: false }) }],
    ['after', { after: JSON.stringify({ enabled: false }) }],
    ['justification', { justification: 'forged justification' }],
    ['dataSnapshotId', { dataSnapshotId: 999 }],
    ['prevHash', { prevHash: 'deadbeef' }],
    ['hash', { hash: 'deadbeef' }],
  ];

  it.each(TAMPER_CASES)('detects tampering of %s at the tampered event\'s index', (_fieldName, patch) => {
    const chain = buildChain();
    const tampered = tamper(chain, 2, patch);
    const result = verifyAuditChain(tampered, stubHash);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failedAtIndex).toBe(2);
  });
});
