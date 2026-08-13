import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:fraktole_remote/app.dart';
import 'package:fraktole_remote/core/security/secure_store.dart';
import 'package:fraktole_remote/core/transport/remote_gateway.dart';
import 'package:fraktole_remote/screens/home_shell.dart';
import 'package:fraktole_remote/state/app_controller.dart';

import '../helpers/fake_gateway.dart';

void main() {
  FakeRemoteGateway gatewayWithRpc() {
    final g = FakeRemoteGateway();
    g.onRpc = (method, params) {
      if (method == 'sessions.list') return <Object?>[];
      throw RemoteException('no fake result for $method');
    };
    return g;
  }

  testWidgets('pair flow persists token, deviceId and fingerprint',
      (tester) async {
    final kv = InMemoryKeyValueStore();
    final g1 = gatewayWithRpc();
    await tester.pumpWidget(FraktoleRemoteApp(
      controller: AppController(store: ConnectionStore(kv: kv), gateway: g1),
    ));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextFormField).at(0), 'desktop.local:8833');
    await tester.enterText(find.byType(TextFormField).at(1), 'ABCD-EFGH');
    await tester.tap(find.widgetWithText(FilledButton, 'Connect'));
    await tester.pumpAndSettle();

    final persisted = await ConnectionStore(kv: kv).read();
    expect(persisted, isNotNull);
    expect(persisted!.token, 't' * 64);
    expect(persisted.deviceId, 'device-1');
    expect(persisted.fingerprint, 'f' * 64);
    expect(persisted.host, 'desktop.local');
    expect(persisted.port, 8833);
    expect(g1.connectCalls.single['fingerprint'], 'f' * 64);
  });

  testWidgets('a fresh app instance reconnects with the persisted token',
      (tester) async {
    final kv = InMemoryKeyValueStore();
    final g1 = gatewayWithRpc();
    await tester.pumpWidget(FraktoleRemoteApp(
      controller: AppController(store: ConnectionStore(kv: kv), gateway: g1),
    ));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextFormField).at(0), 'desktop.local:8833');
    await tester.enterText(find.byType(TextFormField).at(1), 'ABCD-EFGH');
    await tester.tap(find.widgetWithText(FilledButton, 'Connect'));
    await tester.pumpAndSettle();

    final persisted = await ConnectionStore(kv: kv).read();

    await tester.pumpWidget(const SizedBox());
    await tester.pumpAndSettle();

    final g2 = gatewayWithRpc();
    await tester.pumpWidget(FraktoleRemoteApp(
      controller: AppController(store: ConnectionStore(kv: kv), gateway: g2),
    ));
    await tester.pumpAndSettle();

    expect(g2.pairCalls, isEmpty);
    expect(g2.connectCalls, hasLength(1));
    expect(g2.connectCalls.single['token'], persisted!.token);
    expect(g2.connectCalls.single['host'], 'desktop.local');
    expect(find.byType(HomeShell), findsOneWidget);
  });
}
