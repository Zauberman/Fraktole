// Full end-to-end on-device test against the LIVE desktop bridge.
// Uses the phone's already-stored credentials so NO pairing code is required.
// Run:  adb reverse tcp:8833 tcp:8833
//       flutter test integration_test/pair_and_control_test.dart -d <device>
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:fraktole_remote/app.dart';
import 'package:fraktole_remote/core/protocol/models.dart';
import 'package:fraktole_remote/core/protocol/pairing_code.dart';
import 'package:fraktole_remote/core/security/secure_store.dart';
import 'package:fraktole_remote/core/transport/remote_client.dart';
import 'package:fraktole_remote/screens/home_shell.dart';
import 'package:fraktole_remote/screens/tile_detail_screen.dart';
import 'package:fraktole_remote/screens/tiles_screen.dart';
import 'package:fraktole_remote/state/app_controller.dart';

Future<void> pumpUntil(WidgetTester tester, Finder finder,
    {Duration timeout = const Duration(seconds: 45)}) async {
  final end = DateTime.now().add(timeout);
  while (DateTime.now().isBefore(end)) {
    await tester.pump(const Duration(milliseconds: 250));
    if (finder.evaluate().isNotEmpty) return;
  }
  throw TestFailure('timed out waiting for $finder');
}

Future<void> pumpFor(WidgetTester tester, Duration duration) async {
  final end = DateTime.now().add(duration);
  while (DateTime.now().isBefore(end)) {
    await tester.pump(const Duration(milliseconds: 200));
  }
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  // Hermetic credentials: pass a valid device token + pinned fingerprint so
  // the test never depends on the phone's prior manual pairing state.
  //   --dart-define=TOKEN=<64hex> --dart-define=FINGERPRINT=<64hex>
  const token = String.fromEnvironment('TOKEN');
  const fingerprint = String.fromEnvironment('FINGERPRINT');
  const hostPort = String.fromEnvironment('HOST', defaultValue: '127.0.0.1:8833');
  final hp = HostPort.tryParse(hostPort);

  testWidgets('full remote-control loop on device', (tester) async {
    expect(token.isNotEmpty, isTrue,
        reason: 'pass --dart-define=TOKEN=<64hex> (a device token)');
    expect(fingerprint.isNotEmpty, isTrue,
        reason: 'pass --dart-define=FINGERPRINT=<64hex>');
    expect(hp, isNotNull);

    final store = ConnectionStore(kv: SecureKeyValueStore());
    // Seed secure storage exactly like a completed pairing would.
    await store.write(StoredConnection(
      host: hp!.host,
      port: hp.port,
      token: token,
      deviceId: 'test-device',
      fingerprint: fingerprint,
      deviceName: 'e2e-test',
    ));

    final controller = AppController(store: store, gateway: RemoteClient());
    await tester.pumpWidget(FraktoleRemoteApp(controller: controller));
    await tester.pump();

    // 1. Auto-connect with the stored token (no pairing code needed).
    await pumpUntil(tester, find.byType(HomeShell));
    expect(controller.phase, AppPhase.connected,
        reason: 'stored token should auto-connect');
    expect(controller.authInfo, isNotNull);
    debugPrint(
        'E2E: connected to ${controller.authInfo!.serverName} v${controller.authInfo!.version}');

    // 2. Spawn an agent from the phone.
    final spawn = await controller.spawnAgent(name: 'phone-e2e');
    expect(spawn.agentId, isNotEmpty);
    debugPrint('E2E: spawned ${spawn.agentId}');

    // 3. Locate the session holding the spawned tile.
    final sessions = await controller.sessions();
    expect(sessions, isNotEmpty, reason: 'desktop should report sessions');
    Session? target;
    List<Tile> tiles = const [];
    for (final s in sessions) {
      final t = await controller.tiles(s.id);
      if (t.any((x) => x.id == spawn.agentId)) {
        target = s;
        tiles = t;
        break;
      }
    }
    target ??= sessions.firstWhere((s) => s.tileCount > 0,
        orElse: () => sessions.first);
    if (tiles.isEmpty) tiles = await controller.tiles(target.id);
    expect(tiles, isNotEmpty, reason: 'should have a tile to open');
    // Prefer the tile we just spawned (its shell has live scrollback).
    final spawned = tiles.where((t) => t.id == spawn.agentId);
    final tile = spawned.isNotEmpty ? spawned.first : tiles.first;
    debugPrint('E2E: opening ${tile.name} in session ${target.name}');

    // 4. UI: Sessions tab -> session card -> tiles -> tile detail.
    await pumpUntil(tester, find.text(target.name));
    await tester.tap(find.text(target.name));
    await tester.pump();
    await pumpUntil(tester, find.text('Refresh'));
    await pumpUntil(tester, find.text(tile.name));
    await tester.tap(find.text(tile.name));
    await tester.pump();

    // 5. Tile detail: subscription goes live, terminal output streams in.
    await pumpUntil(tester, find.byType(TileDetailScreen));
    // subscribed -> the status chip is no longer '…'
    await pumpUntil(tester, find.textContaining(RegExp('live|idle')));
    await pumpFor(tester, const Duration(seconds: 2));
    expect(find.text('No output yet'), findsNothing,
        reason: 'live tile should have streamed scrollback');
    debugPrint('E2E: tile ${tile.name} shows streamed scrollback');

    // 6. Back to Home, Orchestrator tab, send a task to the spawned agent.
    // The tile detail and tiles routes both have Back buttons in the tree,
    // so pop the Navigator explicitly (top route first).
    Navigator.of(tester.element(find.byType(TileDetailScreen))).pop();
    await tester.pump(const Duration(milliseconds: 400));
    Navigator.of(tester.element(find.byType(TilesScreen))).pop();
    await tester.pump(const Duration(milliseconds: 400));
    await tester.tap(find.text('Orchestrator'));
    await tester.pump();
    await pumpUntil(tester, find.text('Send a task'));

    final body = 'hello from phone e2e at ${DateTime.now().toIso8601String()}';
    await tester.enterText(
        find.widgetWithText(TextFormField, 'Agent ID'), spawn.agentId);
    await tester.enterText(find.widgetWithText(TextFormField, 'Body'), body);
    await tester.tap(find.text('Send'));
    await tester.pump();
    await pumpUntil(tester, find.textContaining('Task sent'));
    debugPrint('E2E: task send acknowledged');

    // 7. Verify the task landed in the desktop mailbox.
    final msgs = await controller.listMessages(limit: 20);
    expect(msgs.any((m) => m.body.contains('hello from phone e2e')), isTrue,
        reason: 'task should appear in the desktop mailbox');
    debugPrint('E2E: task confirmed in desktop mailbox');
    // No explicit controller.dispose(): the widget tree's teardown at the end
    // of the test disposes AppController (and the gateway) itself.
  });
}
