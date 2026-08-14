// Live on-device integration test: pairs the real app with the running
// desktop bridge (reachable via `adb reverse tcp:8833 tcp:8833`) using a
// fresh one-time pairing code, then lists sessions and tiles through the
// actual RemoteClient + AppController — no fakes.
//
// Run:
//   adb reverse tcp:8833 tcp:8833
//   flutter test integration_test/pair_and_control_test.dart \
//     -d <device> --dart-define=HOST=127.0.0.1:8833 \
//     --dart-define=PAIR_CODE=XXXX-XXXX
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:fraktole_remote/app.dart';
import 'package:fraktole_remote/core/protocol/pairing_code.dart';
import 'package:fraktole_remote/core/security/secure_store.dart';
import 'package:fraktole_remote/core/transport/remote_client.dart';
import 'package:fraktole_remote/screens/home_shell.dart';
import 'package:fraktole_remote/state/app_controller.dart';

Future<void> pumpUntil(
  WidgetTester tester,
  Finder finder, {
  Duration timeout = const Duration(seconds: 45),
}) async {
  final end = DateTime.now().add(timeout);
  while (DateTime.now().isBefore(end)) {
    await tester.pump(const Duration(milliseconds: 250));
    if (finder.evaluate().isNotEmpty) return;
  }
  throw TestFailure('timed out waiting for $finder');
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  const host = String.fromEnvironment('HOST', defaultValue: '127.0.0.1:8833');
  const code = String.fromEnvironment('PAIR_CODE');

  testWidgets('pairs with the live desktop, lands on Home, lists sessions and tiles',
      (tester) async {
    expect(code, isNotEmpty, reason: 'pass --dart-define=PAIR_CODE=XXXX-XXXX');
    final hostPort = HostPort.tryParse(host);
    expect(hostPort, isNotNull, reason: 'HOST must be host:port');

    final controller = AppController(
      store: ConnectionStore(kv: SecureKeyValueStore()),
      gateway: RemoteClient(),
    );
    // deterministic start: forget any previously stored connection
    await controller.forget();
    await tester.pumpWidget(FraktoleRemoteApp(controller: controller));
    await tester.pump();

    // we are on the Connect screen
    await pumpUntil(tester, find.text('Connect'));
    expect(find.text('Fraktole Remote'), findsOneWidget);

    // fill the form the way a user would
    await tester.enterText(
        find.widgetWithText(TextFormField, 'Desktop address'), host);
    await tester.enterText(
        find.widgetWithText(TextFormField, 'Pairing code'), code);
    await tester.pump();

    // tap Connect — real TLS + pairing against the desktop bridge
    await tester.tap(find.text('Connect'));
    await tester.pump();

    // pairing must succeed and land on the Home shell
    await pumpUntil(tester, find.byType(HomeShell));
    expect(controller.phase, AppPhase.connected);
    expect(controller.authInfo, isNotNull);

    // drive the orchestrator from the phone: list sessions
    final sessions = await controller.sessions();
    expect(sessions, isNotEmpty, reason: 'desktop should report live sessions');
    // and tiles of the first session
    final tiles = await controller.tiles(sessions.first.id);
    expect(tiles, isNotNull);

    controller.dispose();
  });
}
