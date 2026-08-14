import 'package:flutter_test/flutter_test.dart';
import 'package:fraktole_remote/core/protocol/models.dart';

void main() {
  group('Session.fromJson — desktop wire shape', () {
    // The desktop sends updatedAt as epoch milliseconds (a number), which
    // used to crash the sessions screen with
    // "type 'int' is not a subtype of type 'String' in type cast".
    test('accepts updatedAt as an epoch-ms number', () {
      final session = Session.fromJson({
        'id': 's1',
        'name': 'Fraktole',
        'project': '/home/walid/Fraktole',
        'alive': true,
        'tileCount': 3,
        'updatedAt': 1786668903546,
      });
      expect(session.id, 's1');
      expect(session.alive, isTrue);
      expect(session.tileCount, 3);
      expect(session.updatedAt, isNotNull);
      expect(
        session.updatedAt!.millisecondsSinceEpoch,
        1786668903546,
      );
    });

    test('accepts updatedAt as a numeric string too', () {
      final session = Session.fromJson({
        'id': 's2',
        'updatedAt': '1786668903546',
      });
      expect(session.updatedAt, isNotNull);
    });

    test('accepts updatedAt as an ISO string', () {
      final session = Session.fromJson({
        'id': 's3',
        'updatedAt': '2026-08-14T01:55:03.546Z',
      });
      expect(session.updatedAt, isNotNull);
    });

    test('tolerates a missing updatedAt', () {
      final session = Session.fromJson({
        'id': 's4',
        'name': 'x',
        'alive': false,
      });
      expect(session.updatedAt, isNull);
      expect(session.id, 's4');
    });
  });

  group('Tile.fromJson', () {
    test('parses the documented wire fields', () {
      final tile = Tile.fromJson({
        'id': 'agent-1',
        'name': 'opencode',
        'kind': 'agent',
        'cwd': '/tmp/proj',
        'lines': 42,
        'lastActiveAgoSec': 7,
      });
      expect(tile.kind, 'agent');
      expect(tile.lines, 42);
      expect(tile.lastActiveAgoSec, 7);
    });
  });

  group('MailMessage.fromJson', () {
    test('parses ts as a number', () {
      final msg = MailMessage.fromJson({
        'kind': 'task',
        'from': 'orchestrator',
        'to': 'agent-1',
        'body': 'go',
        'ts': 1786668903546,
      });
      expect(msg.ts, 1786668903546);
    });
  });
}
