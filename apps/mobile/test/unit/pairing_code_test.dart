import 'package:flutter_test/flutter_test.dart';
import 'package:fraktole_remote/core/protocol/pairing_code.dart';

void main() {
  group('PairingCode', () {
    test('normalize uppercases and strips separators', () {
      expect(PairingCode.normalize('abcd-efgh'), 'ABCD-EFGH');
      expect(PairingCode.normalize('abcd efgh'), 'ABCD-EFGH');
      expect(PairingCode.normalize('abcd'), 'ABCD');
      expect(PairingCode.normalize('a1b2c3d4e5f6'), 'A1B2-C3D4');
    });

    test('accepts only XXXX-XXXX with A-Z/0-9', () {
      expect(PairingCode.isValid('ABCD-EFGH'), isTrue);
      expect(PairingCode.isValid('A1B2-C3D4'), isTrue);
      expect(PairingCode.isValid('abcd-efgh'), isFalse);
      expect(PairingCode.isValid('ABCD-EFG'), isFalse);
      expect(PairingCode.isValid('ABCDEFGH'), isFalse);
      expect(PairingCode.isValid('ABCD-EFGH-'), isFalse);
      expect(PairingCode.isValid('ABC!-EFGH'), isFalse);
      expect(PairingCode.isValid(''), isFalse);
    });
  });

  group('HostPort', () {
    test('parses host:port', () {
      final hp = HostPort.tryParse('192.168.1.20:8833');
      expect(hp, isNotNull);
      expect(hp!.host, '192.168.1.20');
      expect(hp.port, 8833);
    });

    test('defaults port to 8833', () {
      final hp = HostPort.tryParse('fraktoledesk.local');
      expect(hp, isNotNull);
      expect(hp!.host, 'fraktoledesk.local');
      expect(hp.port, 8833);
    });

    test('rejects bad input', () {
      expect(HostPort.tryParse(''), isNull);
      expect(HostPort.tryParse('   '), isNull);
      expect(HostPort.tryParse('host:0'), isNull);
      expect(HostPort.tryParse('host:70000'), isNull);
      expect(HostPort.tryParse('host:abc'), isNull);
      expect(HostPort.tryParse('2001:db8::1'), isNull);
      expect(HostPort.tryParse(':8833'), isNull);
    });

    test('builds wss uri', () {
      final hp = HostPort.tryParse('192.168.1.20:8833')!;
      expect(hp.toWsUri().toString(), 'wss://192.168.1.20:8833/');
    });
  });
}
