import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:fraktole_remote/app.dart';
import 'package:fraktole_remote/core/security/secure_store.dart';
import 'package:fraktole_remote/core/transport/remote_gateway.dart';
import 'package:fraktole_remote/screens/connect_screen.dart';
import 'package:fraktole_remote/screens/home_shell.dart';
import 'package:fraktole_remote/state/app_controller.dart';

import '../helpers/fake_gateway.dart';

void main() {
  Future<(FakeRemoteGateway, InMemoryKeyValueStore)> pumpApp(
    WidgetTester tester, {
    FakeRemoteGateway? gateway,
    InMemoryKeyValueStore? kv,
  }) async {
    final g = gateway ?? FakeRemoteGateway();
    final k = kv ?? InMemoryKeyValueStore();
    g.onRpc = (method, params) {
      if (method == 'sessions.list') return <Object?>[];
      if (method == 'messages.list') return <Object?>[];
      throw RemoteException('no fake result for $method');
    };
    await tester.pumpWidget(FraktoleRemoteApp(
      controller: AppController(store: ConnectionStore(kv: k), gateway: g),
    ));
    await tester.pumpAndSettle();
    return (g, k);
  }

  testWidgets('connect screen rejects an invalid pairing code', (tester) async {
    final (g, _) = await pumpApp(tester);

    await tester.enterText(find.byType(TextFormField).at(0), '192.168.1.20:8833');
    await tester.enterText(find.byType(TextFormField).at(1), 'ABCD');
    await tester.tap(find.widgetWithText(FilledButton, 'Connect'));
    await tester.pump();

    expect(find.text('Format XXXX-XXXX, letters or digits'), findsOneWidget);
    expect(g.pairCalls, isEmpty);
  });

  testWidgets('connect screen rejects a bad host', (tester) async {
    final (g, _) = await pumpApp(tester);

    await tester.enterText(find.byType(TextFormField).at(0), 'host:notaport');
    await tester.enterText(find.byType(TextFormField).at(1), 'ABCD-EFGH');
    await tester.tap(find.widgetWithText(FilledButton, 'Connect'));
    await tester.pump();

    expect(
      find.text('Enter host:port (e.g. 192.168.1.20:8833)'),
      findsOneWidget,
    );
    expect(g.pairCalls, isEmpty);
  });

  testWidgets('valid code pairs and lands on the sessions screen',
      (tester) async {
    final (g, kv) = await pumpApp(tester);

    await tester.enterText(find.byType(TextFormField).at(0), '192.168.1.20:8833');
    await tester.enterText(find.byType(TextFormField).at(1), 'abcd-efgh');
    await tester.enterText(
        find.byType(TextFormField).at(2), 'Pixel 8');
    await tester.tap(find.widgetWithText(FilledButton, 'Connect'));
    await tester.pumpAndSettle();

    expect(g.pairCalls, hasLength(1));
    final call = g.pairCalls.single;
    expect(call['code'], 'ABCD-EFGH');
    expect(call['host'], '192.168.1.20');
    expect(call['port'], 8833);
    expect(call['deviceName'], 'Pixel 8');
    expect(find.byType(HomeShell), findsOneWidget);
    expect(find.text('Sessions'), findsWidgets);

    final persisted = await ConnectionStore(kv: kv).read();
    expect(persisted, isNotNull);
    expect(persisted!.token, 't' * 64);
    expect(persisted.deviceId, 'device-1');
    expect(persisted.fingerprint, 'f' * 64);
  });

  testWidgets('pairing failure surfaces the server reason', (tester) async {
    final g = FakeRemoteGateway()
      ..onPair = (host, port, code, deviceName) =>
          throw const RemoteException('Pairing code is invalid');
    final (_, _) = await pumpApp(tester, gateway: g);

    await tester.enterText(find.byType(TextFormField).at(0), '192.168.1.20:8833');
    await tester.enterText(find.byType(TextFormField).at(1), 'ABCD-EFGH');
    await tester.tap(find.widgetWithText(FilledButton, 'Connect'));
    await tester.pumpAndSettle();

    expect(find.byType(ConnectScreen), findsOneWidget);
    expect(find.text('Pairing code is invalid'), findsOneWidget);
  });
}
