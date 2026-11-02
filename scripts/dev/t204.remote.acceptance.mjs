#!/usr/bin/env node
// Explicit binding pin: --expected-version 5 [--ids file] [--binding-id id].
// Bounded command and PTY, both tied to the same verified remote channel.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {acceptanceReport, assertBindingIds, assertRemoteSelection, assertOwnedOperation, readTaskUntil, sha, sleep, isMain, remoteMain} from './acceptance-contracts.mjs';

export async function runT204({ids, expectedVersion, rpc, uuid = randomUUID, sleep: pause = sleep, attempts = 80, onPass}) {
  const run = uuid(), commandId = 't204-cmd-' + run;
  let commandStarted = false, releaseAttempted = false, terminalId, terminalClosed = false;
  return acceptanceReport('T-204 remote command/PTY on an explicitly pinned single channel; bounded, no lifecycle', ids, run, async pass => {
    assertBindingIds(ids, expectedVersion);
    const channel = await assertRemoteSelection(rpc, ids);
    const row = async (operationId, kind, state) => assertOwnedOperation(await rpc('operation.get', {operation_id: operationId}), ids, operationId, channel, kind, state);
    const action = (method, operationId, extra = {}) => rpc('task.' + method, {session_id: ids.session_id, operation_id: operationId, action_id: uuid(), ...extra});
    try {
      const marker = 'T204_REMOTE_CMD_' + run;
      const started = await rpc('command.start', {session_id: ids.session_id, operation_id: commandId, argv: ['/usr/bin/bash', '-c', "printf '%s\\n' '" + marker + "'"]});
      commandStarted = true;
      assert.equal(started.operation_id, commandId, 'command start operation mismatch');
      const command = await row(commandId, 'command.exec');
      assert.equal(started.processId, command.remote_process_id, 'command start process mismatch');
      assert.equal(started.pid, command.remote_pid, 'command start PID mismatch');
      const output = await readTaskUntil({rpc, ids, operationId: commandId, marker, requireExit: true, attempts, sleep: pause});
      await row(commandId, 'command.exec', 'completed');
      releaseAttempted = true;
      const releaseId = uuid();
      const released = await rpc('task.release', {session_id: ids.session_id, operation_id: commandId, action_id: releaseId});
      assert.equal(released.released, true, 'remote command release not confirmed');
      assert.equal(released.operation_id, releaseId, 'release action ID mismatch');
      await row(releaseId, 'task.release', 'completed');
      await row(commandId, 'command.exec', 'released');
      pass('remote command emits stdout marker, exits zero, and confirms release of exact provider operation', {operation_id: commandId, status: output.status, text_sha256: sha(Buffer.from(output.stdout)), final_state: 'released'});

      terminalId = uuid();
      const created = await rpc('terminal/create', {args: {agentId: ids.session_id, request: {id: terminalId, rows: 24, cols: 80}}}, '/api');
      assert.ok(created && typeof created === 'object', 'terminal create acknowledgement missing');
      if (created.agentId !== undefined) assert.equal(created.agentId, ids.session_id, 'terminal session mismatch');
      if (created.session_id !== undefined) assert.equal(created.session_id, ids.session_id, 'terminal session mismatch');
      const operationId = 'terminal-' + sha(ids.session_id + '\0' + terminalId);
      await row(operationId, 'pty.open', 'running');
      const ptyMarker = 'T204_REMOTE_PTY_' + run;
      // The complete output nonce is deliberately absent from submitted input.
      // An echo-only PTY can never satisfy the standalone output-line assertion.
      const split = Math.floor(ptyMarker.length / 2);
      const input = "printf '%s%s\\n' '" + ptyMarker.slice(0, split) + "' '" + ptyMarker.slice(split) + "'\n";
      assert.equal(input.includes(ptyMarker), false, 'PTY challenge appears verbatim in input');
      await action('input', operationId, {data: input});
      const ptyOutput = await readTaskUntil({rpc, ids, operationId, marker: ptyMarker, attempts, sleep: pause});
      const cancelled = await action('cancel', operationId);
      assert.equal(cancelled.running, false, 'PTY cancellation not confirmed');
      const stopped = await rpc('task.status', {session_id: ids.session_id, operation_id: operationId});
      assert.equal(stopped.running, false, 'PTY still running after cancellation');
      await rpc('terminal/close', {args: {agentId: ids.session_id, id: terminalId}}, '/api');
      terminalClosed = true;
      let final;
      for (let i = 0; i < attempts; i++) {
        final = await row(operationId, 'pty.open');
        if (final.state === 'released') break;
        assert.ok(['completed', 'cancelled'].includes(final.state), 'PTY cleanup outcome unknown or still running: ' + final.state);
        if (i + 1 < attempts) await pause(200);
      }
      assert.equal(final.state, 'released', 'PTY release not confirmed');
      const after = await assertRemoteSelection(rpc, ids);
      assert.equal(after.channel_id, channel.channel_id, 'remote channel changed during acceptance');
      assert.equal(after.helper_session_id, channel.helper_session_id, 'remote helper session changed during acceptance');
      pass('remote PTY executes non-echo output challenge, stops and confirms exact operation release on the same channel', {terminal_id: terminalId, operation_id: operationId, final_state: final.state, output_sha256: sha(Buffer.from(ptyOutput.stdout))});
    } catch (error) {
      // Cleanup never starts or replays a task. Cleanup uncertainty cannot PASS.
      const cleanupErrors = [];
      if (terminalId && !terminalClosed) {
        try { await rpc('terminal/close', {args: {agentId: ids.session_id, id: terminalId}}, '/api'); }
        catch (cleanup) { cleanupErrors.push(cleanup.code ?? cleanup.name); }
      }
      if (commandStarted && !releaseAttempted) {
        try {
          const status = await rpc('task.status', {session_id: ids.session_id, operation_id: commandId});
          if (status.running === true) await action('cancel', commandId);
          await action('release', commandId);
        } catch (cleanup) { cleanupErrors.push(cleanup.code ?? cleanup.name); }
      }
      if (cleanupErrors.length) error.cleanupErrors = cleanupErrors;
      throw error;
    }
  }, onPass);
}

if (isMain(import.meta.url)) await remoteMain('t204', 't204-remote-', runT204);
