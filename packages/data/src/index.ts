import { CORE_PACKAGE_NAME } from '@copilot-budget/core';

export const DATA_PACKAGE_NAME = '@copilot-budget/data';
export const DATA_DEPENDS_ON = CORE_PACKAGE_NAME;

export * from './db/schema';
export * from './db/client';
export * from './msw/handlers';
export * from './msw/server';
export * from './msw/fixtures';
