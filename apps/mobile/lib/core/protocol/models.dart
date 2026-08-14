class Session {
  const Session({
    required this.id,
    required this.name,
    required this.project,
    required this.alive,
    required this.tileCount,
    this.updatedAt,
  });

  final String id;
  final String name;
  final String project;
  final bool alive;
  final int tileCount;
  final DateTime? updatedAt;

  static Session fromJson(Map<String, Object?> json) => Session(
        id: json['id'] as String,
        name: json['name'] as String? ?? '',
        project: json['project'] as String? ?? '',
        alive: json['alive'] as bool? ?? false,
        tileCount: json['tileCount'] as int? ?? 0,
        updatedAt: parseUpdatedAt(json['updatedAt']),
      );
}

class Tile {
  const Tile({
    required this.id,
    required this.name,
    required this.kind,
    required this.cwd,
    required this.lines,
    required this.lastActiveAgoSec,
  });

  final String id;
  final String name;
  final String kind;
  final String cwd;
  final int lines;
  final int lastActiveAgoSec;

  static Tile fromJson(Map<String, Object?> json) => Tile(
        id: json['id'] as String,
        name: json['name'] as String? ?? '',
        kind: json['kind'] as String? ?? 'shell',
        cwd: json['cwd'] as String? ?? '',
        lines: json['lines'] as int? ?? 0,
        lastActiveAgoSec: json['lastActiveAgoSec'] as int? ?? 0,
      );
}

class MailMessage {
  const MailMessage({
    required this.kind,
    required this.from,
    required this.to,
    required this.body,
    required this.ts,
  });

  final String kind;
  final String from;
  final String to;
  final String body;
  final int ts;

  DateTime get timestamp => DateTime.fromMillisecondsSinceEpoch(ts);

  static MailMessage fromJson(Map<String, Object?> json) => MailMessage(
        kind: json['kind'] as String? ?? '',
        from: json['from'] as String? ?? '',
        to: json['to'] as String? ?? '',
        body: json['body'] as String? ?? '',
        ts: _asInt(json['ts']),
      );
}

/// The desktop sends `updatedAt` as epoch-milliseconds (a number). Accept a
/// number, a numeric string, or an ISO string so a mismatch can never crash
/// the sessions screen with a type-cast error.
DateTime? parseUpdatedAt(Object? value) {
  if (value is int) return DateTime.fromMillisecondsSinceEpoch(value);
  if (value is num) return DateTime.fromMillisecondsSinceEpoch(value.toInt());
  if (value is String) {
    final ms = int.tryParse(value);
    if (ms != null) return DateTime.fromMillisecondsSinceEpoch(ms);
    return DateTime.tryParse(value);
  }
  return null;
}

int _asInt(Object? value) {
  if (value is int) return value;
  if (value is num) return value.toInt();
  if (value is String) return int.tryParse(value) ?? 0;
  return 0;
}
