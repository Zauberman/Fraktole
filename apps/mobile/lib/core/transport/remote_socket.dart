import 'dart:async';
import 'dart:io';

import 'package:crypto/crypto.dart';

class RemoteSocket {
  RemoteSocket._(this._webSocket, this._httpClient);

  final WebSocket _webSocket;
  final HttpClient _httpClient;

  Stream<String> get messages => _webSocket.cast<String>();

  void send(String data) => _webSocket.add(data);

  Future<void> close() async {
    try {
      await _webSocket.close();
    } catch (_) {}
    _httpClient.close(force: true);
  }

  static Future<RemoteSocket> open(
    Uri uri, {
    required bool acceptAnyCert,
    String? pinnedFingerprint,
    void Function(String fingerprint)? onPeerFingerprint,
  }) async {
    final client = HttpClient()
      ..connectionTimeout = const Duration(seconds: 10)
      ..idleTimeout = const Duration(seconds: 30);
    client.badCertificateCallback = (certificate, host, port) {
      final fingerprint = sha256.convert(certificate.der).toString();
      if (acceptAnyCert) {
        onPeerFingerprint?.call(fingerprint);
        return true;
      }
      final expected = pinnedFingerprint;
      if (expected == null) return false;
      return fingerprint.toLowerCase() == expected.toLowerCase();
    };
    final webSocket = await WebSocket.connect(
      uri.toString(),
      customClient: client,
    );
    return RemoteSocket._(webSocket, client);
  }
}
