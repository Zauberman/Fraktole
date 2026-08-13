import 'package:flutter/material.dart';

import 'app.dart';
import 'core/security/secure_store.dart';
import 'core/transport/remote_client.dart';
import 'state/app_controller.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(FraktoleRemoteApp(
    controller: AppController(
      store: ConnectionStore(kv: SecureKeyValueStore()),
      gateway: RemoteClient(),
    ),
  ));
}
