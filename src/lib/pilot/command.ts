/** Pure command boundary. Schema capability is trusted server configuration, never request input or posting authorization. */
import {executeDemo, requireDemoActionPermission, type DemoAction, type DemoState} from '../demo/store';
import type {Role} from '../security/permissions';
import {validateCommand} from './input';

export type PilotCommandCapabilities = Readonly<{zeroChargeTrips?: true; customerReceipts?: true}>;

/** Caller supplies its verified server role. Does not authenticate, persist, connect or change schema. */
export function executePilotCommand(state: DemoState, action: DemoAction, key: string, role: Role, capabilities?: PilotCommandCapabilities): DemoState {
  validateCommand(action);
  requireDemoActionPermission(role, action);
  const zeroRequested = (action.type === 'CREATE_TRIP' && action.trip.amount === 0n) || (action.type === 'EDIT_TRIP' && action.replacement?.amount === 0n);
  if (zeroRequested && capabilities?.zeroChargeTrips !== true) {
    throw new Error('Zero-charge daily trips require the reviewed pilot schema upgrade. No record was saved.');
  }
  return executeDemo(state, action, key, role, {
    allowZeroDailyTrips: capabilities?.zeroChargeTrips,
    allowCustomerReceipts: capabilities?.customerReceipts,
  });
}
