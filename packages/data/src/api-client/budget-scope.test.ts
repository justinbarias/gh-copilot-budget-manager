import { describe, expect, it } from 'vitest';
import { internalBudgetIdentityToWire, wireBudgetToInternal } from './budget-scope.js';

// Pins the OpenAPI-verified budget-scope translation table
// (wire-contract-writes.md §1). This mapper fixes a REAL live read bug: live
// budgets return user/multi_user_customer scopes, which the old parse
// (classifying by internal spellings) misfiled.
describe('wireBudgetToInternal', () => {
  it('maps multi_user_customer -> internal universal', () => {
    expect(wireBudgetToInternal({ budget_scope: 'multi_user_customer', budget_entity_name: 'dewr' })).toEqual({
      scope: 'universal',
      entityName: 'dewr',
    });
  });

  it("maps scope 'user' -> internal individual, login taken from the `user` field", () => {
    expect(
      wireBudgetToInternal({ budget_scope: 'user', budget_entity_name: 'dewr', user: 'liam-obrien' }),
    ).toEqual({ scope: 'individual', entityName: 'liam-obrien' });
    // Defensive fallback only when the response omits the user field.
    expect(wireBudgetToInternal({ budget_scope: 'user', budget_entity_name: 'ext-dmorrow' })).toEqual({
      scope: 'individual',
      entityName: 'ext-dmorrow',
    });
  });

  it('passes multi_user_cost_center and the resource scopes through unchanged', () => {
    for (const scope of ['multi_user_cost_center', 'enterprise', 'organization', 'cost_center'] as const) {
      expect(wireBudgetToInternal({ budget_scope: scope, budget_entity_name: 'x' })).toEqual({ scope, entityName: 'x' });
    }
  });

  it('returns null for scopes with no internal home (repository, unknown future values) -- never invents one', () => {
    expect(wireBudgetToInternal({ budget_scope: 'repository', budget_entity_name: 'dewr/api' })).toBeNull();
    expect(wireBudgetToInternal({ budget_scope: 'some_future_scope', budget_entity_name: 'x' })).toBeNull();
  });
});

describe('internalBudgetIdentityToWire', () => {
  it('serializes internal universal -> wire multi_user_customer', () => {
    expect(internalBudgetIdentityToWire('universal', 'dewr')).toEqual({
      budget_scope: 'multi_user_customer',
      budget_entity_name: 'dewr',
    });
  });

  it("serializes internal individual -> wire scope 'user' + the user login field", () => {
    expect(internalBudgetIdentityToWire('individual', 'rpatel2')).toEqual({
      budget_scope: 'user',
      budget_entity_name: 'rpatel2',
      user: 'rpatel2',
    });
  });

  it('passes the remaining internal scopes through unchanged', () => {
    for (const scope of ['multi_user_cost_center', 'enterprise', 'organization', 'cost_center'] as const) {
      expect(internalBudgetIdentityToWire(scope, 'x')).toEqual({ budget_scope: scope, budget_entity_name: 'x' });
    }
  });

  it('round-trips through the wire for every internal scope (write then read yields the same identity)', () => {
    for (const scope of ['universal', 'individual', 'multi_user_cost_center', 'enterprise', 'organization', 'cost_center'] as const) {
      const wire = internalBudgetIdentityToWire(scope, 'entity-1');
      expect(wireBudgetToInternal(wire)).toEqual({ scope, entityName: 'entity-1' });
    }
  });
});
