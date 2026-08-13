import 'package:flutter/material.dart';

import 'screens/connect_screen.dart';
import 'screens/home_shell.dart';
import 'screens/splash_screen.dart';
import 'state/app_controller.dart';

class FraktoleRemoteApp extends StatefulWidget {
  const FraktoleRemoteApp({super.key, required this.controller});

  final AppController controller;

  @override
  State<FraktoleRemoteApp> createState() => _FraktoleRemoteAppState();
}

class _FraktoleRemoteAppState extends State<FraktoleRemoteApp> {
  @override
  void initState() {
    super.initState();
    widget.controller.init();
  }

  @override
  void dispose() {
    widget.controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Fraktole Remote',
      theme: ThemeData(
        brightness: Brightness.dark,
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF7C5CFF),
          brightness: Brightness.dark,
        ),
        useMaterial3: true,
      ),
      home: ListenableBuilder(
        listenable: widget.controller,
        builder: (context, _) {
          switch (widget.controller.phase) {
            case AppPhase.connected:
              return HomeShell(controller: widget.controller);
            case AppPhase.pairing:
            case AppPhase.needsPairing:
            case AppPhase.authFailed:
              return ConnectScreen(controller: widget.controller);
            case AppPhase.connecting:
              return SplashScreen(
                controller: widget.controller,
                label: widget.controller.stored == null
                    ? 'Connecting…'
                    : 'Connecting to ${widget.controller.stored!.host}…',
              );
          }
        },
      ),
    );
  }
}
