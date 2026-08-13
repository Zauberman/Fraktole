import '../protocol/events.dart';

enum ConnectionStatus { disconnected, connecting, connected, authFailed }

class RemoteException implements Exception {
  const RemoteException(this.message, {this.code});

  final String message;
  final int? code;

  @override
  String toString() => message;
}

class PairResult {
  const PairResult({
    required this.token,
    required this.deviceId,
    required this.fingerprint,
  });

  final String token;
  final String deviceId;
  final String fingerprint;
}

class SendTaskResult {
  const SendTaskResult({required this.messageId});

  final String messageId;
}

class SpawnAgentResult {
  const SpawnAgentResult({required this.agentId});

  final String agentId;
}

class AuthInfo {
  const AuthInfo({
    required this.serverName,
    required this.version,
    required this.deviceId,
  });

  final String serverName;
  final String version;
  final String deviceId;
}

abstract class RemoteGateway {
  ConnectionStatus get status;
  AuthInfo? get authInfo;
  String? get serverFingerprint;
  String? get lastError;

  Stream<ConnectionStatus> get statusChanges;

  Future<PairResult> pair({
    required String host,
    required int port,
    required String code,
    required String deviceName,
  });

  Future<void> connect({
    required String host,
    required int port,
    required String token,
    required String fingerprint,
  });

  Future<void> disconnect();

  Future<Object?> rpc(String method, [Map<String, Object?> params = const {}]);

  Future<void> subscribeTile({required String sessionId, required String tileId});

  Future<void> unsubscribeTile({required String tileId});

  Stream<TileOutputEvent> get tileOutputs;
  Stream<TileSnapshotEvent> get tileSnapshots;
  Stream<TileStateEvent> get tileStates;
  Stream<SessionStateEvent> get sessionStates;
  Stream<MessageNewEvent> get messageNews;

  void dispose();
}
