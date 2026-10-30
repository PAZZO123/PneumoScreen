// lung.h – PneumoScreen lung-sound classification module
// Wraps the PDM → decimate → MFCC → int8 CNN pipeline from firmware/lung_sound.
// Non-blocking: call lung_start() to begin, lung_update() each loop,
// lung_done() to check, lung_result() to read the classification.
#pragma once
#include <stdint.h>

#define LUNG_WINDOWS 10   // average over 10 inference windows (~10 s)

// Start lung-sound capture and classification.
// Initialises PDM, resets accumulators.
void lung_start();

// Call every loop iteration. Runs inference when enough audio is buffered.
void lung_update();

// Returns true when LUNG_WINDOWS inferences have been averaged.
bool lung_done();

// Best class index: 0=normal, 1=crackles, 2=wheezes, 3=noise
int lung_class();

// Best class name
const char* lung_class_name();

// Averaged softmax probabilities (4 elements)
const float* lung_probs();

// Stop PDM and free resources.
void lung_stop();

// Feed mode: send 'F' + 32000 int16 samples over serial
void lung_handle_feed();
