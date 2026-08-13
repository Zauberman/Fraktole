import 'dart:convert';

class PairFrame {
  const PairFrame({required this.code, required this.deviceName});

  final String code;
  final String deviceName;

  Map<String, Object?> toJson() => {
        'type': 'pair',
        'code': code,
        'deviceName': deviceName,
      };

  String encode() => jsonEncode(toJson());
}

class AuthFrame {
  const AuthFrame({required this.token});

  final String token;

  Map<String, Object?> toJson() => {'type': 'auth', 'token': token};

  String encode() => jsonEncode(toJson());
}

class PongFrame {
  const PongFrame({required this.params});

  final Map<String, Object?> params;

  Map<String, Object?> toJson() => {'type': 'pong', 'params': params};

  String encode() => jsonEncode(toJson());
}

class PairOk {
  const PairOk({
    required this.token,
    required this.deviceId,
    required this.serverFingerprint,
  });

  final String token;
  final String deviceId;
  final String serverFingerprint;

  static PairOk fromJson(Map<String, Object?> json) => PairOk(
        token: json['token'] as String,
        deviceId: json['deviceId'] as String,
        serverFingerprint: json['serverFingerprint'] as String,
      );
}

class PairFail {
  const PairFail({required this.reason});

  final String reason;

  static PairFail fromJson(Map<String, Object?> json) =>
      PairFail(reason: json['reason'] as String? ?? 'unknown');
}

class AuthOk {
  const AuthOk({
    required this.serverName,
    required this.version,
    required this.deviceId,
  });

  final String serverName;
  final String version;
  final String deviceId;

  static AuthOk fromJson(Map<String, Object?> json) => AuthOk(
        serverName: json['serverName'] as String,
        version: json['version'] as String,
        deviceId: json['deviceId'] as String,
      );
}

class AuthFail {
  const AuthFail({required this.reason});

  final String reason;

  static AuthFail fromJson(Map<String, Object?> json) =>
      AuthFail(reason: json['reason'] as String? ?? 'unknown');
}
