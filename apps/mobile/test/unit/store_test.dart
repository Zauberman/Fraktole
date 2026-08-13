import 'package:flutter_test/flutter_test.dart';
import 'package:fraktole_remote/core/security/secure_store.dart';

void main() {
  group('ConnectionStore token persistence', () {
    late InMemoryKeyValueStore kv;
    late ConnectionStore store;

    setUp(() {
      kv = InMemoryKeyValueStore();
      store = ConnectionStore(kv: kv);
    });

    test('writes and reads back token, deviceId and fingerprint', () async {
      final connection = StoredConnection(
        host: '192.168.1.20',
        port: 8833,
        token: 'a' * 64,
        deviceId: 'uuid-1234',
        fingerprint: 'b' * 64,
        deviceName: 'Pixel 8',
      );
      await store.write(connection);
      final read = await store.read();
      expect(read, isNotNull);
      expect(read!.token, 'a' * 64);
      expect(read.deviceId, 'uuid-1234');
      expect(read.fingerprint, 'b' * 64);
      expect(read.host, '192.168.1.20');
      expect(read.port, 8833);
      expect(read.deviceName, 'Pixel 8');
    });

    test('overwrites existing credentials', () async {
      await store.write(const StoredConnection(
        host: 'a',
        port: 1,
        token: 't1',
        deviceId: 'd1',
        fingerprint: 'f1',
        deviceName: 'n1',
      ));
      await store.write(const StoredConnection(
        host: 'b',
        port: 2,
        token: 't2',
        deviceId: 'd2',
        fingerprint: 'f2',
        deviceName: 'n2',
      ));
      final read = await store.read();
      expect(read!.token, 't2');
      expect(read.deviceId, 'd2');
    });

    test('clear removes credentials', () async {
      await store.write(const StoredConnection(
        host: 'a',
        port: 1,
        token: 't1',
        deviceId: 'd1',
        fingerprint: 'f1',
        deviceName: 'n1',
      ));
      await store.clear();
      expect(await store.read(), isNull);
    });

    test('corrupt stored JSON yields null', () async {
      await kv.write('fraktole.connection.v1', '{not json');
      expect(await store.read(), isNull);
    });

    test('missing data yields null', () async {
      expect(await store.read(), isNull);
    });
  });
}
