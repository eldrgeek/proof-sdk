import { EventEmitter } from 'node:events';

// Process-local notification; durable authorization always checks document_access.
export const documentAccessEvents = new EventEmitter();
