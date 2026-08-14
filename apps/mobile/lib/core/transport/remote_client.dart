import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../protocol/events.dart';
import '../protocol/frames.dart';
import '../protocol/rpc.dart';
import 'remote_gateway.dart';
import 'remote_socket.dart';

class RemoteClient implements RemoteGateway {
  RemoteClient({this._rpcTimeout = const Duration(seconds: 15)});

  final Duration _rpcTimeout;

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

  RemoteSocket? _socket;
  StreamSubscription<String>? _socketSub;
  Timer? _reconnectTimer;
  Timer? _authTimeout;

  ConnectionStatus _status = ConnectionStatus.disconnected;
  AuthInfo? _authInfo;
  String? _serverFingerprint;
  String? _lastError;

  String? _host;
  int? _port;
  String? _token;
  String? _pinnedFingerprint;
  bool _keepOpen = false;
  bool _authFailed = false;
  int _backoffAttempt = 0;
  int _nextId = 1;
  final Map<int, Completer<Object?>> _pending = {};
  final Map<String, String> _subscribedTiles = {};

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

  void _setStatus(ConnectionStatus value) {
    _status = value;
    _statusController.add(value);
  }

  @override
  Future<PairResult> pair({
    required String host,
    required int port,
    required String code,
    required String deviceName,
  }) async {
    String? fingerprint;
    final socket = await RemoteSocket.open(
      Uri.parse('wss://$host:$port/'),
      acceptAnyCert: true,
      onPeerFingerprint: (fp) => fingerprint = fp,
    );
    try {
      socket.send(PairFrame(code: code, deviceName: deviceName).encode());
      late Map<String, Object?> pairResponse;
      try {
        pairResponse = await socket.messages
            .map(_decodeJson)
            .where((m) => m != null)
            .cast<Map<String, Object?>>()
            .first
            .timeout(const Duration(seconds: 10));
      } on TimeoutException {
        throw const RemoteException('Desktop did not respond to pairing');
      } on StateError {
        throw const RemoteException('Desktop closed the pairing connection');
      }
      final type = pairResponse['type'];
      if (type == 'pair-ok') {
        final ok = PairOk.fromJson(pairResponse);
        final captured = fingerprint ?? '';
        final serverFingerprint =
            captured.isNotEmpty ? captured : ok.serverFingerprint;
        return PairResult(
          token: ok.token,
          deviceId: ok.deviceId,
          fingerprint: serverFingerprint,
        );
      }
      if (type == 'pair-fail') {
        final fail = PairFail.fromJson(pairResponse);
        throw RemoteException(_pairFailMessage(fail.reason),
            code: RpcErrorCodes.notAuthenticated);
      }
      throw RemoteException('Unexpected response during pairing: $type');
    } finally {
      await socket.close();
    }
  }

  String _pairFailMessage(String reason) {
    switch (reason) {
      case 'invalid-code':
        return 'Pairing code is invalid';
      case 'expired':
        return 'Pairing code has expired';
      default:
        return 'Pairing failed: $reason';
    }
  }

  @override
  Future<void> connect({
    required String host,
    required int port,
    required String token,
    required String fingerprint,
  }) async {
    _host = host;
    _port = port;
    _token = token;
    _pinnedFingerprint = fingerprint;
    _keepOpen = true;
    _authFailed = false;
    _backoffAttempt = 0;
    await _connectOnce();
  }

  Future<void> _connectOnce() async {
    if (!_keepOpen) return;
    _setStatus(ConnectionStatus.connecting);
    _reconnectTimer?.cancel();
    _authTimeout?.cancel();
    _socketSub?.cancel();
    _socketSub = null;
    _socket?.close();
    _socket = null;
    _serverFingerprint = _pinnedFingerprint;
    try {
      final socket = await RemoteSocket.open(
        Uri.parse('wss://$_host:$_port/'),
        acceptAnyCert: false,
        pinnedFingerprint: _pinnedFingerprint,
      );
      if (!_keepOpen) {
        await socket.close();
        return;
      }
      _socket = socket;
      _socketSub = socket.messages.listen(
        _onMessage,
        onDone: _onSocketClosed,
        onError: (_) => _onSocketClosed(),
      );
      socket.send(AuthFrame(token: _token!).encode());
      _authTimeout = Timer(const Duration(seconds: 8), () {
        _onSocketClosed();
      });
    } catch (e) {
      _lastError = '$e';
      if (e is SocketException) {
        _onSocketClosed();
        return;
      }
      _failFatal();
    }
  }

  void _failFatal() {
    _keepOpen = false;
    _failAllPending(RemoteException(
      _lastError ?? 'Connection failed',
      code: RpcErrorCodes.connectionClosed,
    ));
    _setStatus(ConnectionStatus.disconnected);
  }

  void _onMessage(String raw) {
    _authTimeout?.cancel();
    final json = _decodeJson(raw);
    if (json is! Map<String, Object?>) return;
    if (json['type'] is String) {
      _onServerFrame(json);
      return;
    }
    if (json['id'] is int) {
      final response = RpcResponse.fromJson(json);
      if (response != null) _onRpcResponse(response);
    }
  }

  Map<String, Object?>? _decodeJson(String raw) {
    try {
      final decoded = jsonDecode(raw);
      return decoded is Map<String, Object?> ? decoded : null;
    } on FormatException {
      return null;
    }
  }

  void _onServerFrame(Map<String, Object?> json) {
    final type = json['type'] as String;
    if (type == 'auth-ok') {
      final ok = AuthOk.fromJson(json);
      _authInfo = AuthInfo(
        serverName: ok.serverName,
        version: ok.version,
        deviceId: ok.deviceId,
      );
      _setStatus(ConnectionStatus.connected);
      _backoffAttempt = 0;
      _resubscribeTiles();
      return;
    }
    if (type == 'auth-fail') {
      final fail = AuthFail.fromJson(json);
      _authFailed = true;
      _keepOpen = false;
      _setStatus(ConnectionStatus.authFailed);
      _failAllPending(RemoteException(
        fail.reason == 'bad-token'
            ? 'Token rejected by server'
            : 'Authentication failed: ${fail.reason}',
        code: RpcErrorCodes.notAuthenticated,
      ));
      _socket?.close();
      return;
    }
    if (type == 'pong') return;
    final event = ServerEvent.fromJson(json);
    if (event is TileOutputEvent) {
      _tileOutputs.add(TileOutputEvent(
        tileId: _clientTileId(event.tileId),
        data: event.data,
        ts: event.ts,
      ));
    } else if (event is TileSnapshotEvent) {
      _tileSnapshots.add(TileSnapshotEvent(
        tileId: _clientTileId(event.tileId),
        data: event.data,
      ));
    } else if (event is TileStateEvent) {
      _tileStates.add(TileStateEvent(
        tileId: _clientTileId(event.tileId),
        alive: event.alive,
        lines: event.lines,
      ));
    } else if (event is SessionStateEvent) {
      _sessionStates.add(event);
    } else if (event is MessageNewEvent) {
      _messageNews.add(event);
    } else if (event is PingFrame) {
      _socket?.send(PongFrame(params: {'ts': event.ts}).encode());
    }
  }

  void _onRpcResponse(RpcResponse response) {
    final completer = _pending.remove(response.id);
    if (completer == null) return;
    if (response.isError) {
      completer.completeError(RemoteException(
        response.error!.message,
        code: response.error!.code,
      ));
    } else {
      completer.complete(response.result);
    }
  }

  void _failAllPending(Object error) {
    for (final completer in _pending.values) {
      completer.completeError(error);
    }
    _pending.clear();
  }

  void _onSocketClosed() {
    _authTimeout?.cancel();
    _socketSub?.cancel();
    _socketSub = null;
    final socket = _socket;
    _socket = null;
    socket?.close();
    _failAllPending(const RemoteException(
      'Connection closed',
      code: RpcErrorCodes.connectionClosed,
    ));
    if (!_keepOpen) {
      _setStatus(ConnectionStatus.disconnected);
      return;
    }
    if (_authFailed) return;
    final delay = _backoffDelay(_backoffAttempt++);
    _setStatus(ConnectionStatus.connecting);
    _reconnectTimer = Timer(delay, _connectOnce);
  }

  Duration _backoffDelay(int attempt) {
    if (attempt >= 8) return const Duration(seconds: 30);
    return Duration(seconds: 1 << attempt);
  }

  void _resubscribeTiles() {
    for (final entry in _subscribedTiles.entries) {
      rpc('tile.subscribe', {'sessionId': entry.value, 'tileId': entry.key})
          .catchError((Object e) => null);
    }
  }

  @override
  Future<Object?> rpc(String method, [Map<String, Object?> params = const {}]) {
    if (_status != ConnectionStatus.connected) {
      return Future.error(const RemoteException(
        'Not connected',
        code: RpcErrorCodes.notAuthenticated,
      ));
    }
    final id = _nextId++;
    final completer = Completer<Object?>();
    _pending[id] = completer;
    _socket?.send(RpcRequest(id: id, method: method, params: params).encode());
    final timer = Timer(_rpcTimeout, () {
      if (_pending.remove(id) != null) {
        completer.completeError(const RemoteException(
          'Request timed out',
          code: RpcErrorCodes.timeout,
        ));
      }
    });
    return completer.future.whenComplete(timer.cancel);
  }

  /// Reverse mapping: live tile id (as tagged in streamed events) -> the
  /// client-facing agent id the UI subscribed with.
  final Map<String, String> _liveToClientTile = {};

  /// Resolves a tile id from a streamed event to the client-facing id the
  /// UI knows. The desktop tags tile.output/snapshot/state with the *live*
  /// recorder tile id, which differs from the agent id the UI uses; without
  /// this mapping the tile detail screen would never match its events.
  String _clientTileId(String eventTileId) =>
      _liveToClientTile[eventTileId] ?? eventTileId;

  @override
  Future<void> subscribeTile({
    required String sessionId,
    required String tileId,
  }) async {
    _subscribedTiles[tileId] = sessionId;
    final result = await rpc(
        'tile.subscribe', {'sessionId': sessionId, 'tileId': tileId});
    // the desktop answers { ok: true } (and, on current builds, liveTileId)
    if (result is Map<String, Object?>) {
      final live = result['liveTileId'];
      if (live is String && live.isNotEmpty) {
        _liveToClientTile[live] = tileId;
      }
    }
  }

  @override
  Future<void> unsubscribeTile({required String tileId}) async {
    _subscribedTiles.remove(tileId);
    _liveToClientTile.removeWhere((_, v) => v == tileId);
    try {
      await rpc('tile.unsubscribe', {'tileId': tileId});
    } catch (_) {}
  }

  @override
  Future<void> disconnect() async {
    _keepOpen = false;
    _reconnectTimer?.cancel();
    _authTimeout?.cancel();
    _failAllPending(const RemoteException(
      'Disconnected',
      code: RpcErrorCodes.connectionClosed,
    ));
    await _socket?.close();
    _socket = null;
    _socketSub?.cancel();
    _socketSub = null;
    _setStatus(ConnectionStatus.disconnected);
  }

  @override
  void dispose() {
    _keepOpen = false;
    _reconnectTimer?.cancel();
    _authTimeout?.cancel();
    _failAllPending(const RemoteException(
      'Disposed',
      code: RpcErrorCodes.connectionClosed,
    ));
    _socketSub?.cancel();
    _socketSub = null;
    _socket?.close();
    _socket = null;
    _statusController.close();
    _tileOutputs.close();
    _tileSnapshots.close();
    _tileStates.close();
    _sessionStates.close();
    _messageNews.close();
  }
}
