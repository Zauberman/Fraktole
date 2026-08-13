import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

abstract class KeyValueStore {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);
}

class SecureKeyValueStore implements KeyValueStore {
  SecureKeyValueStore({FlutterSecureStorage? storage})
      : _storage = storage ?? const FlutterSecureStorage();

  final FlutterSecureStorage _storage;

  @override
  Future<String?> read(String key) => _storage.read(key: key);

  @override
  Future<void> write(String key, String value) =>
      _storage.write(key: key, value: value);

  @override
  Future<void> delete(String key) => _storage.delete(key: key);
}

class InMemoryKeyValueStore implements KeyValueStore {
  final Map<String, String> _data = {};

  @override
  Future<String?> read(String key) async => _data[key];

  @override
  Future<void> write(String key, String value) async {
    _data[key] = value;
  }

  @override
  Future<void> delete(String key) async {
    _data.remove(key);
  }
}

class StoredConnection {
  const StoredConnection({
    required this.host,
    required this.port,
    required this.token,
    required this.deviceId,
    required this.fingerprint,
    required this.deviceName,
  });

  final String host;
  final int port;
  final String token;
  final String deviceId;
  final String fingerprint;
  final String deviceName;

  Map<String, Object?> toJson() => {
        'host': host,
        'port': port,
        'token': token,
        'deviceId': deviceId,
        'fingerprint': fingerprint,
        'deviceName': deviceName,
      };

  static StoredConnection? fromJson(Map<String, Object?> json) {
    final host = json['host'];
    final port = json['port'];
    final token = json['token'];
    final deviceId = json['deviceId'];
    final fingerprint = json['fingerprint'];
    if (host is! String ||
        port is! int ||
        token is! String ||
        deviceId is! String ||
        fingerprint is! String) {
      return null;
    }
    return StoredConnection(
      host: host,
      port: port,
      token: token,
      deviceId: deviceId,
      fingerprint: fingerprint,
      deviceName: json['deviceName'] as String? ?? '',
    );
  }
}

class ConnectionStore {
  ConnectionStore({required this._kv});

  static const String _key = 'fraktole.connection.v1';

  final KeyValueStore _kv;

  Future<StoredConnection?> read() async {
    final raw = await _kv.read(_key);
    if (raw == null) return null;
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! Map<String, Object?>) return null;
      return StoredConnection.fromJson(decoded);
    } on FormatException {
      return null;
    }
  }

  Future<void> write(StoredConnection connection) =>
      _kv.write(_key, jsonEncode(connection.toJson()));

  Future<void> clear() => _kv.delete(_key);
}
