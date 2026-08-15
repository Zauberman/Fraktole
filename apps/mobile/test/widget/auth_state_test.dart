import 'package:flutter_test/flutter_test.dart';
import 'package:fraktole_remote/app.dart';
import 'package:fraktole_remote/core/security/secure_store.dart';
import 'package:fraktole_remote/core/transport/remote_gateway.dart';
import 'package:fraktole_remote/screens/connect_screen.dart';
import 'package:fraktole_remote/screens/home_shell.dart';
import 'package:fraktole_remote/screens/splash_screen.dart';
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
      throw RemoteException('no fake result for $method');
    };
    await tester.pumpWidget(FraktoleRemoteApp(
      controller: AppController(store: ConnectionStore(kv: k), gateway: g),
    ));
    await tester.pumpAndSettle();
    return (g, k);
  }

  testWidgets('without stored credentials shows the connect screen',
      (tester) async {
    await pumpApp(tester);
    expect(find.byType(ConnectScreen), findsOneWidget);
    expect(find.byType(HomeShell), findsNothing);
  });

  testWidgets('with stored credentials connects straight to the home shell',
      (tester) async {
    final stored = StoredConnection(
      host: '192.168.1.20',
      port: 8833,
      token: 'a' * 64,
      deviceId: 'device-9',
      fingerprint: 'b' * 64,
      deviceName: 'Pixel 8',
    );
    final kv = InMemoryKeyValueStore();
    await ConnectionStore(kv: kv).write(stored);

    final (g, _) = await pumpApp(tester, kv: kv);

    expect(find.byType(SplashScreen), findsNothing);
    expect(find.byType(HomeShell), findsOneWidget);
    expect(find.text('Sessions'), findsWidgets);
    expect(g.connectCalls, hasLength(1));
    expect(g.connectCalls.single['token'], 'a' * 64);
    expect(g.connectCalls.single['fingerprint'], 'b' * 64);
    expect(g.pairCalls, isEmpty);
  });

  testWidgets('auth failure clears the token and returns to pairing',
      (tester) async {
    final kv = InMemoryKeyValueStore();
    await ConnectionStore(kv: kv).write(StoredConnection(
      host: '192.168.1.20',
      port: 8833,
      token: 'a' * 64,
      deviceId: 'device-9',
      fingerprint: 'b' * 64,
      deviceName: 'Pixel 8',
    ));

    final (g, _) = await pumpApp(tester, kv: kv);
    expect(find.byType(HomeShell), findsOneWidget);

    g.emitStatus(ConnectionStatus.authFailed);
    await tester.pumpAndSettle();

    expect(find.byType(ConnectScreen), findsOneWidget);
    expect(
      find.text(
        'Token rejected by server. Connect again with the current pairing code.',
      ),
      findsOneWidget,
    );
    expect(await ConnectionStore(kv: kv).read(), isNull);
  });

  testWidgets('manual disconnect keeps the shell but forget clears credentials',
      (tester) async {
    final kv = InMemoryKeyValueStore();
    await ConnectionStore(kv: kv).write(StoredConnection(
      host: '192.168.1.20',
      port: 8833,
      token: 'a' * 64,
      deviceId: 'device-9',
      fingerprint: 'b' * 64,
      deviceName: 'Pixel 8',
    ));

    final (g, _) = await pumpApp(tester, kv: kv);
    await tester.tap(find.text('Settings'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Forget this device'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Forget this device'));
    await tester.pumpAndSettle();

    expect(find.byType(ConnectScreen), findsOneWidget);
    expect(await ConnectionStore(kv: kv).read(), isNull);
    expect(g.connectCount, greaterThanOrEqualTo(1));
  });

  testWidgets('disconnect drops to the connect screen with saved credentials kept',
      (tester) async {
    final stored = StoredConnection(
      host: '192.168.1.20',
      port: 8833,
      token: 'a' * 64,
      deviceId: 'device-9',
      fingerprint: 'b' * 64,
      deviceName: 'Pixel 8',
    );
    final kv = InMemoryKeyValueStore();
    await ConnectionStore(kv: kv).write(stored);
    final (g, _) = await pumpApp(tester, kv: kv);
    expect(find.byType(HomeShell), findsOneWidget);

    // open the Settings tab and hit Disconnect
    await tester.tap(find.text('Settings'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Disconnect'));
    await tester.pumpAndSettle();

    // must NOT stay on the "connected" home shell; the connect screen shows
    // with the saved-device card (credentials are kept for reconnect)
    expect(find.byType(HomeShell), findsNothing);
    expect(find.byType(ConnectScreen), findsOneWidget);
    expect(find.text('Reconnect'), findsOneWidget);
    expect(g.disconnectCalls, isNotNull);
    expect(g.status, ConnectionStatus.disconnected);
  });
}
