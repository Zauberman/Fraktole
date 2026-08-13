import 'package:flutter/material.dart';

import '../core/transport/remote_gateway.dart';
import '../state/app_controller.dart';

class SplashScreen extends StatelessWidget {
  const SplashScreen({super.key, required this.controller, required this.label});

  final AppController controller;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const SizedBox(
              width: 48,
              height: 48,
              child: CircularProgressIndicator(strokeWidth: 3),
            ),
            const SizedBox(height: 24),
            Text(label, style: Theme.of(context).textTheme.bodyLarge),
            const SizedBox(height: 8),
            if (controller.connectionStatus == ConnectionStatus.connecting)
              TextButton(
                onPressed: () => controller.disconnect(),
                child: const Text('Cancel'),
              ),
          ],
        ),
      ),
    );
  }
}
