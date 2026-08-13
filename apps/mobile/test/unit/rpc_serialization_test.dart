import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:fraktole_remote/core/protocol/rpc.dart';

void main() {
  group('RPC request serialization', () {
    test('request envelope matches wire format', () {
      final request = RpcRequest(
        id: 1,
        method: 'sessions.list',
        params: const {},
      );
      final decoded = jsonDecode(request.encode()) as Map<String, dynamic>;
      expect(decoded['id'], 1);
      expect(decoded['method'], 'sessions.list');
      expect(decoded['params'], isEmpty);
    });

    test('request with params serializes them', () {
      final request = RpcRequest(
        id: 7,
        method: 'tile.subscribe',
        params: const {'sessionId': 's1', 'tileId': 't2'},
      );
      final decoded = jsonDecode(request.encode()) as Map<String, dynamic>;
      expect(decoded['id'], 7);
      expect(decoded['params'], {'sessionId': 's1', 'tileId': 't2'});
    });

    test('result response parses', () {
      final response = RpcResponse.fromJson(
          jsonDecode('{"id":1,"result":{"ok":true}}') as Map<String, dynamic>);
      expect(response, isNotNull);
      expect(response!.id, 1);
      expect(response.isError, isFalse);
      expect((response.result as Map)['ok'], isTrue);
    });

    test('error response parses code and message', () {
      final response = RpcResponse.fromJson(jsonDecode(
          '{"id":2,"error":{"code":-32601,"message":"unknown method"}}') as Map<String, dynamic>);
      expect(response, isNotNull);
      expect(response!.isError, isTrue);
      expect(response.error!.code, -32601);
      expect(response.error!.message, 'unknown method');
    });

    test('malformed response is rejected', () {
      expect(
        RpcResponse.fromJson(jsonDecode('{"id":3}') as Map<String, dynamic>),
        isNull,
      );
      expect(
        RpcResponse.fromJson(
            jsonDecode('{"method":"x"}') as Map<String, dynamic>),
        isNull,
      );
    });
  });

  group('Error codes', () {
    test('constants match protocol', () {
      expect(RpcErrorCodes.unknownMethod, -32601);
      expect(RpcErrorCodes.parse, -32700);
      expect(RpcErrorCodes.notAuthenticated, -32000);
    });
  });
}
