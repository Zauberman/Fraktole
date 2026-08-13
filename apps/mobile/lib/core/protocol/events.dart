class TileOutputEvent {
  const TileOutputEvent({required this.tileId, required this.data, required this.ts});

  final String tileId;
  final String data;
  final int ts;
}

class TileSnapshotEvent {
  const TileSnapshotEvent({required this.tileId, required this.data});

  final String tileId;
  final String data;
}

class TileStateEvent {
  const TileStateEvent({required this.tileId, required this.alive, required this.lines});

  final String tileId;
  final bool alive;
  final int lines;
}

class SessionStateEvent {
  const SessionStateEvent({required this.sessionId, required this.alive});

  final String sessionId;
  final bool alive;
}

class MessageNewEvent {
  const MessageNewEvent({
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
}

class PingFrame {
  const PingFrame({required this.ts});

  final int ts;
}

class ServerEvent {
  static Object? fromJson(Map<String, Object?> json) {
    final type = json['type'];
    final params = json['params'];
    if (params is! Map<String, Object?>) return null;
    switch (type) {
      case 'tile.output':
        return TileOutputEvent(
          tileId: params['tileId'] as String,
          data: _coerceString(params['data']),
          ts: params['ts'] as int? ?? 0,
        );
      case 'tile.snapshot':
        return TileSnapshotEvent(
          tileId: params['tileId'] as String,
          data: _coerceString(params['data']),
        );
      case 'tile.state':
        return TileStateEvent(
          tileId: params['tileId'] as String,
          alive: params['alive'] as bool? ?? false,
          lines: params['lines'] as int? ?? 0,
        );
      case 'session.state':
        return SessionStateEvent(
          sessionId: params['sessionId'] as String,
          alive: params['alive'] as bool? ?? false,
        );
      case 'message.new':
        return MessageNewEvent(
          kind: params['kind'] as String? ?? '',
          from: params['from'] as String? ?? '',
          to: params['to'] as String? ?? '',
          body: _coerceString(params['body']),
          ts: params['ts'] as int? ?? 0,
        );
      case 'ping':
        return PingFrame(ts: params['ts'] as int? ?? 0);
    }
    return null;
  }

  static String _coerceString(Object? value) {
    if (value == null) return '';
    if (value is String) return value;
    if (value is List<int>) return String.fromCharCodes(value);
    return value.toString();
  }
}
