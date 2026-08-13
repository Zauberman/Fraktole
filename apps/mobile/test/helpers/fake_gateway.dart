import 'dart:async';

import 'package:fraktole_remote/core/protocol/events.dart';
import 'package:fraktole_remote/core/transport/remote_gateway.dart';

class FakeRemoteGateway implements RemoteGateway {
  final StreamController<ConnectionStatus> _statusController =
      StreamController.broadcast();
  final StreamController<TileOutputEvent> _tileOutputs =
      StreamController.broadcast();
  final StreamController<TileSnapshotEvent> _tileSnapshots =
      StreamController.broadcast();
  final StreamController<TileStateEvent> _tileStates =
      StreamController.broadcast();
  final StreamController<SessionStateEvent> _sessionStates =
      StreamController.broadcast();
  final StreamController<MessageNewEvent> _messageNews =
      StreamController.broadcast();

  ConnectionStatus _status = ConnectionStatus.disconnected;
  AuthInfo? _authInfo;
  String? _serverFingerprint;
  String? _lastError;

  PairResult Function(String host, int port, String code, String deviceName)?
      onPair;
  Object? Function(String method, Map<String, Object?> params)? onRpc;
  Map<String, Map<String, Object?>> rpcResults = {};
  bool failConnect = false;
  String? failConnectError;

  final List<Map<String, Object?>> pairCalls = [];
  final List<Map<String, Object?>> connectCalls = [];
  final List<Map<String, Object?>> subscribeCalls = [];
  final List<Map<String, Object?>> unsubscribeCalls = [];
  final List<String> rpcCalls = [];
  int connectCount = 0;

  @override
  ConnectionStatus get status => _status;

  @override
  AuthInfo? get authInfo => _authInfo;

  @override
  String? get serverFingerprint => _serverFingerprint;

  @override
  String? get lastError => _lastError;

  @override
  Stream<ConnectionStatus> get statusChanges => _statusController.stream;

  @override
  Stream<TileOutputEvent> get tileOutputs => _tileOutputs.stream;

  @override
  Stream<TileSnapshotEvent> get tileSnapshots => _tileSnapshots.stream;

  @override
  Stream<TileStateEvent> get tileStates => _tileStates.stream;

  @override
  Stream<SessionStateEvent> get sessionStates => _sessionStates.stream;

  @override
  Stream<MessageNewEvent> get messageNews => _messageNews.stream;

  void emitStatus(ConnectionStatus status) {
    _status = status;
    _statusController.add(status);
  }

  void emitTileOutput(String tileId, String data, {int ts = 0}) {
    _tileOutputs.add(TileOutputEvent(tileId: tileId, data: data, ts: ts));
  }

  void emitTileSnapshot(String tileId, String data) {
    _tileSnapshots.add(TileSnapshotEvent(tileId: tileId, data: data));
  }

  void emitTileState(String tileId, {required bool alive, required int lines}) {
    _tileStates.add(TileStateEvent(tileId: tileId, alive: alive, lines: lines));
  }

  void emitMessageNew(Map<String, Object?> message) {
    _messageNews.add(MessageNewEvent(
      kind: message['kind'] as String? ?? '',
      from: message['from'] as String? ?? '',
      to: message['to'] as String? ?? '',
      body: message['body'] as String? ?? '',
      ts: message['ts'] as int? ?? 0,
    ));
  }

  @override
  Future<PairResult> pair({
    required String host,
    required int port,
    required String code,
    required String deviceName,
  }) async {
    pairCalls.add({'host': host, 'port': port, 'code': code, 'deviceName': deviceName});
    final custom = onPair;
    if (custom != null) {
      return custom(host, port, code, deviceName);
    }
    return PairResult(
      token: 't' * 64,
      deviceId: 'device-1',
      fingerprint: 'f' * 64,
    );
  }

  @override
  Future<void> connect({
    required String host,
    required int port,
    required String token,
    required String fingerprint,
  }) async {
    connectCalls.add({
      'host': host,
      'port': port,
      'token': token,
      'fingerprint': fingerprint,
    });
    connectCount++;
    _serverFingerprint = fingerprint;
    if (failConnect) {
      _lastError = failConnectError ?? 'connection refused';
      emitStatus(ConnectionStatus.disconnected);
      throw RemoteException(_lastError!);
    }
    _authInfo = const AuthInfo(serverName: 'Fraktole', version: '0.11.2', deviceId: 'server-1');
    emitStatus(ConnectionStatus.connected);
  }

  @override
  Future<void> disconnect() async {
    _authInfo = null;
    emitStatus(ConnectionStatus.disconnected);
  }

  @override
  Future<Object?> rpc(String method, [Map<String, Object?> params = const {}]) async {
    rpcCalls.add(method);
    final custom = onRpc;
    if (custom != null) return custom(method, params);
    final result = rpcResults[method];
    if (result != null) return result;
    throw RemoteException('no fake result for $method');
  }

  @override
  Future<void> subscribeTile({
    required String sessionId,
    required String tileId,
  }) async {
    subscribeCalls.add({'sessionId': sessionId, 'tileId': tileId});
  }

  @override
  Future<void> unsubscribeTile({required String tileId}) async {
    unsubscribeCalls.add({'tileId': tileId});
  }

  @override
  void dispose() {
    _statusController.close();
    _tileOutputs.close();
    _tileSnapshots.close();
    _tileStates.close();
    _sessionStates.close();
    _messageNews.close();
  }
}
