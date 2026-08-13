import 'package:flutter/foundation.dart';

import '../core/protocol/events.dart';
import '../core/protocol/models.dart';
import '../core/security/secure_store.dart';
import '../core/transport/remote_gateway.dart';

enum AppPhase { needsPairing, pairing, connecting, connected, authFailed }

class AppController extends ChangeNotifier {
  AppController({
    required this._store,
    required this._gateway,
  }) {
    _gateway.statusChanges.listen(_onStatusChange);
  }

  final ConnectionStore _store;
  final RemoteGateway _gateway;

  AppPhase _phase = AppPhase.needsPairing;
  StoredConnection? _stored;
  String? _errorMessage;

  AppPhase get phase => _phase;

  String? get errorMessage => _errorMessage;

  StoredConnection? get stored => _stored;

  ConnectionStatus get connectionStatus => _gateway.status;

  AuthInfo? get authInfo => _gateway.authInfo;

  String? get serverFingerprint => _gateway.serverFingerprint;

  String? get lastError => _gateway.lastError;

  Stream<TileOutputEvent> get tileOutputs => _gateway.tileOutputs;

  Stream<TileSnapshotEvent> get tileSnapshots => _gateway.tileSnapshots;

  Stream<TileStateEvent> get tileStates => _gateway.tileStates;

  Stream<SessionStateEvent> get sessionStates => _gateway.sessionStates;

  Stream<MessageNewEvent> get messageNews => _gateway.messageNews;

  Future<void> init() async {
    _stored = await _store.read();
    if (_stored == null) {
      _setPhase(AppPhase.needsPairing);
      return;
    }
    await _connectStored();
  }

  Future<void> pair({
    required String host,
    required int port,
    required String code,
    required String deviceName,
  }) async {
    _errorMessage = null;
    _setPhase(AppPhase.pairing);
    try {
      final result = await _gateway.pair(
        host: host,
        port: port,
        code: code,
        deviceName: deviceName,
      );
      _stored = StoredConnection(
        host: host,
        port: port,
        token: result.token,
        deviceId: result.deviceId,
        fingerprint: result.fingerprint,
        deviceName: deviceName,
      );
      await _store.write(_stored!);
      notifyListeners();
      await _connectStored();
    } catch (e) {
      _errorMessage = _friendly(e);
      _setPhase(AppPhase.needsPairing);
    }
  }

  Future<void> _connectStored() async {
    final stored = _stored;
    if (stored == null) {
      _setPhase(AppPhase.needsPairing);
      return;
    }
    _errorMessage = null;
    _setPhase(AppPhase.connecting);
    try {
      await _gateway.connect(
        host: stored.host,
        port: stored.port,
        token: stored.token,
        fingerprint: stored.fingerprint,
      );
    } catch (e) {
      _errorMessage = _friendly(e);
      _setPhase(AppPhase.needsPairing);
    }
  }

  void _onStatusChange(ConnectionStatus status) {
    switch (status) {
      case ConnectionStatus.connected:
        _errorMessage = null;
        _setPhase(AppPhase.connected);
      case ConnectionStatus.connecting:
        if (_phase != AppPhase.connected) _setPhase(AppPhase.connecting);
      case ConnectionStatus.authFailed:
        _forgetLocal();
        _errorMessage =
            'Token rejected by server. Connect again with the current pairing code.';
        _setPhase(AppPhase.authFailed);
      case ConnectionStatus.disconnected:
        if (_phase == AppPhase.connecting || _phase == AppPhase.pairing) {
          _setPhase(AppPhase.needsPairing);
        }
    }
  }

  void _setPhase(AppPhase phase) {
    if (_phase == phase) return;
    _phase = phase;
    notifyListeners();
  }

  Future<void> reconnect() async {
    await _connectStored();
  }

  Future<void> disconnect() async {
    await _gateway.disconnect();
    _setPhase(AppPhase.connected);
  }

  Future<void> forget() async {
    await _gateway.disconnect();
    await _forgetLocal();
    _setPhase(AppPhase.needsPairing);
  }

  Future<void> _forgetLocal() async {
    _stored = null;
    await _store.clear();
  }

  Future<List<Session>> sessions() async {
    final result = await _gateway.rpc('sessions.list');
    return _asList(result).map((e) => Session.fromJson(e)).toList();
  }

  Future<List<Tile>> tiles(String sessionId) async {
    final result = await _gateway.rpc('tiles.list', {'sessionId': sessionId});
    return _asList(result).map((e) => Tile.fromJson(e)).toList();
  }

  Future<void> subscribeTile({required String sessionId, required String tileId}) =>
      _gateway.subscribeTile(sessionId: sessionId, tileId: tileId);

  Future<void> unsubscribeTile({required String tileId}) =>
      _gateway.unsubscribeTile(tileId: tileId);

  Future<SendTaskResult> sendTask({
    required String agentId,
    required String kind,
    required String body,
  }) async {
    final result = await _gateway.rpc('task.send', {
      'agentId': agentId,
      'kind': kind,
      'body': body,
    }) as Map<String, Object?>;
    return SendTaskResult(messageId: result['messageId'] as String);
  }

  Future<List<MailMessage>> listMessages({int? limit}) async {
    final result = await _gateway.rpc('messages.list', {
      'limit': ?limit,
    });
    return _asList(result).map((e) => MailMessage.fromJson(e)).toList();
  }

  Future<SpawnAgentResult> spawnAgent({
    String? cwd,
    String? kind,
    String? name,
  }) async {
    final result = await _gateway.rpc('agent.spawn', {
      if (cwd != null && cwd.isNotEmpty) 'cwd': cwd,
      if (kind != null && kind.isNotEmpty) 'kind': kind,
      if (name != null && name.isNotEmpty) 'name': name,
    }) as Map<String, Object?>;
    return SpawnAgentResult(agentId: result['agentId'] as String);
  }

  Future<bool> health() async {
    final result = await _gateway.rpc('health') as Map<String, Object?>;
    return result['ok'] == true;
  }

  List<Map<String, Object?>> _asList(Object? value) {
    if (value is List) return value.whereType<Map<String, Object?>>().toList();
    return const [];
  }

  String _friendly(Object error) {
    if (error is RemoteException) return error.message;
    return 'Connection failed: $error';
  }

  @override
  void dispose() {
    _gateway.dispose();
    super.dispose();
  }
}
