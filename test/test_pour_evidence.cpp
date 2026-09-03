// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

// Host-compilable unit tests for batch pour evidence reduced from RobustFlow.

#include <cstdio>
#include <iterator>
#include <vector>

#include "RobustFlow.h"

namespace {

using pump_scale::computePourEvidence;
using pump_scale::Sample;

int g_failures = 0;

#define CHECK(cond)                                               \
  do {                                                            \
    if (!(cond)) {                                                \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
      ++g_failures;                                               \
    }                                                             \
  } while (0)

void ramp(std::vector<Sample>& s, uint32_t& t, double& cg, double rateCgPerS,
          uint32_t durMs, uint32_t stepMs = 150) {
  const uint32_t end = t + durMs;
  while (t <= end) {
    s.push_back(Sample{t, static_cast<int16_t>(cg)});
    t += stepMs;
    cg += rateCgPerS * stepMs / 1000.0;
  }
}

void flat(std::vector<Sample>& s, uint32_t& t, double cg, uint32_t durMs,
          uint32_t stepMs = 150) {
  const uint32_t end = t + durMs;
  while (t <= end) {
    s.push_back(Sample{t, static_cast<int16_t>(cg)});
    t += stepMs;
  }
}

void testSustainedPourRecognized() {
  std::vector<Sample> s;
  uint32_t t = 0;
  double cg = 0;
  ramp(s, t, cg, 200.0, 8000);
  const auto e = computePourEvidence(s.data(), s.size());
  CHECK(e.hasPour);
  CHECK(e.pourMs >= 6500);
  CHECK(e.gainCg >= 1300);
  CHECK(e.gainCg <= 1800);
}

void testStartWeightIsLastFlatSampleBeforePour() {
  std::vector<Sample> s;
  uint32_t t = 0;
  double cg = 0;
  flat(s, t, 0.0, 3000);
  ramp(s, t, cg, 200.0, 8000);
  flat(s, t, cg, 3000);
  const auto e = computePourEvidence(s.data(), s.size());
  CHECK(e.hasStartRawCg);
  CHECK(e.startRawCg == 0);
  CHECK(e.gainCg >= 1550);
  CHECK(e.gainCg <= 1650);
}

void testSmoothedSettledLagDoesNotMoveStartWeightIntoPour() {
  std::vector<Sample> s;
  uint32_t t = 0;
  flat(s, t, 0.0, 2200, 100);
  double cg = 25;
  ramp(s, t, cg, 600.0, 2000, 100);
  const auto e = computePourEvidence(s.data(), s.size());
  CHECK(e.hasPour);
  CHECK(e.hasStartRawCg);
  CHECK(e.startRawCg == 0);
}

void testTransientThenFlatPlateauSeedsPourStart() {
  // A large transient decays into a flat zero before the pour. The flat samples
  // are the trustworthy starting weight even while smoothed flow is settling.
  std::vector<Sample> s{
      {0, 2800},   {100, 4000}, {200, 3600}, {300, 3000},
      {400, 1000}, {500, 300},  {600, 50},   {700, 0},
  };
  uint32_t t = 800;
  flat(s, t, 0.0, 2000, 100);
  double cg = 0;
  ramp(s, t, cg, 400.0, 1500, 100);
  const auto e = computePourEvidence(s.data(), s.size());
  CHECK(e.hasPour);
  CHECK(e.hasStartRawCg);
  CHECK(e.startRawCg == 0);
}

void testLiftFreezesGainNearPreLiftPeak() {
  // A 25 g pour, then the cup comes off over 1 s. The evidence must freeze
  // near the pre-lift weight instead of following the collapse partway down
  // while the smoothed flow transits Settled/Tail on its way to
  // Discontinuity.
  std::vector<Sample> s;
  uint32_t t = 0;
  double cg = 0;
  flat(s, t, 0.0, 2000);
  ramp(s, t, cg, 178.6, 14000);   // ~25 g over 14 s
  ramp(s, t, cg, -2500.0, 1000);  // lift: -25 g/s
  flat(s, t, 0.0, 5000);
  const auto e = computePourEvidence(s.data(), s.size());
  CHECK(e.hasPour);
  CHECK(e.gainCg >= 2350);
  CHECK(e.gainCg <= 2600);
}

void testPostPumpDiscontinuitySelectsPrecedingEndpoint() {
  std::vector<Sample> s;
  uint32_t t = 0;
  double cg = 0;
  flat(s, t, 0.0, 2000);
  ramp(s, t, cg, 390.0, 12000);  // pour to about 47 g
  flat(s, t, cg, 1200);

  // Some scale modes alternate between positive and negative tare readings
  // after the cup is lifted. End on the positive phase: its sign alone would
  // otherwise make the invalid 71.4 g endpoint look plausible.
  for (int cycle = 0; cycle < 3; ++cycle) {
    flat(s, t, 7140.0, 450);
    flat(s, t, -7140.0, 450);
  }
  flat(s, t, 7140.0, 600);

  int16_t endpoint = 0;
  CHECK(pump_scale::endpointBeforePostPumpDiscontinuity(s.data(), s.size(),
                                                        15000, endpoint));
  CHECK(endpoint >= 4600 && endpoint <= 4800);
}

void testSettledReferenceUsesRepeatedScaleReadings() {
  pump_scale::CausalPourClassifier classifier;
  pump_scale::CausalPourSample result;
  for (uint32_t t = 1000; t <= 1600; t += 200) {
    result = classifier.update(t, 3850);
  }
  CHECK(result.haveSettledReference);
  CHECK(result.settledReferenceUpdated);
  CHECK(result.settledReferenceCg == 3850);

  classifier.reset();
  const int16_t moving[] = {3860, 3870, 3860, 3880};
  uint32_t t = 1000;
  for (const int16_t cg : moving) {
    result = classifier.update(t, cg);
    t += 200;
  }
  CHECK(!result.haveSettledReference);
}

void testPostPumpDiscontinuityDiscardsRecordedHighReading() {
  // Distilled from a recorded extraction: repeated scale readings establish a
  // settled reference, then a brief rise precedes the cup movement.
  const Sample s[] = {
      {29202, 3830}, {29421, 3830}, {29661, 3830}, {29862, 3840}, {30042, 3820},
      {30241, 3850}, {30501, 3850}, {30702, 3850}, {30921, 3850}, {31141, 3850},
      {31421, 3850}, {31642, 3850}, {31922, 3860}, {32142, 3860}, {32321, 3860},
      {32561, 3870}, {32761, 3870}, {32961, 3870}, {33182, 3870}, {33441, 3870},
      {33661, 3880}, {33861, 4110}, {34061, 8850},
  };
  int16_t endpoint = 0;
  CHECK(pump_scale::endpointBeforePostPumpDiscontinuity(s, std::size(s), 30199,
                                                        endpoint));
  CHECK(endpoint == 3880);
}

void testPostPumpDiscontinuityDiscardsRecordedLowReading() {
  // Distilled from a recorded extraction: the lower terminal reading is brief
  // and is followed by a material upward movement.
  const Sample s[] = {
      {25486, 3970}, {25685, 3970}, {25885, 3980}, {26105, 3980},
      {26366, 3980}, {26566, 3990}, {26766, 4000}, {26985, 4000},
      {27205, 4000}, {27425, 4000}, {27647, 4000}, {27906, 4000},
      {28106, 4010}, {28325, 4010}, {28566, 3970}, {28766, 4320},
  };
  int16_t endpoint = 0;
  CHECK(pump_scale::endpointBeforePostPumpDiscontinuity(s, std::size(s), 25485,
                                                        endpoint));
  CHECK(endpoint == 4010);
}

void testPostPumpDiscontinuityDoesNotReuseReferenceAcrossGap() {
  const Sample s[] = {{1000, 3860}, {1200, 3860}, {1400, 3860}, {1600, 3860},
                      {2600, 3860}, {2800, 4110}, {3000, 8850}};
  int16_t endpoint = 0;
  CHECK(pump_scale::endpointBeforePostPumpDiscontinuity(s, std::size(s), 1000,
                                                        endpoint));
  CHECK(endpoint == 4110);
}

void testPostPumpDiscontinuityFallsBackWithoutSettledReference() {
  // A moving sequence does not manufacture a settled reference.
  const Sample s[] = {{1000, 3860}, {1200, 3870}, {1400, 3860},
                      {1600, 3880}, {1800, 4110}, {2000, 8850}};
  int16_t endpoint = 0;
  CHECK(pump_scale::endpointBeforePostPumpDiscontinuity(s, std::size(s), 1000,
                                                        endpoint));
  CHECK(endpoint == 4110);
}

void testPostPumpDiscontinuityDoesNotUsePrePumpReference() {
  const Sample s[] = {{200, 3860},  {400, 3860},  {600, 3860},
                      {800, 3860},  {1000, 3870}, {1200, 3860},
                      {1400, 3870}, {1600, 4110}, {1800, 8850}};
  int16_t endpoint = 0;
  CHECK(pump_scale::endpointBeforePostPumpDiscontinuity(s, std::size(s), 1000,
                                                        endpoint));
  CHECK(endpoint == 4110);
}

void testPostPumpDiscontinuityKeepsInRangeFinalReading() {
  const Sample s[] = {{1000, 3860}, {1200, 3860}, {1400, 3860}, {1600, 3860},
                      {1800, 3840}, {2000, 3880}, {2200, 8850}};
  int16_t endpoint = 0;
  CHECK(pump_scale::endpointBeforePostPumpDiscontinuity(s, std::size(s), 1000,
                                                        endpoint));
  CHECK(endpoint == 3880);
}

void testPostPumpDiscontinuityRecoveryUsesFinalInterval() {
  const Sample atLimit[] = {{1000, 3860}, {1200, 3860}, {1400, 3860},
                            {1600, 3860}, {1800, 3880}, {2000, 4110},
                            {2330, 8850}};
  int16_t endpoint = 0;
  CHECK(pump_scale::endpointBeforePostPumpDiscontinuity(
      atLimit, std::size(atLimit), 1000, endpoint));
  CHECK(endpoint == 3880);

  const Sample overLimit[] = {{1000, 3860}, {1200, 3860}, {1400, 3860},
                              {1600, 3860}, {1800, 3880}, {2000, 4110},
                              {2331, 8850}};
  CHECK(pump_scale::endpointBeforePostPumpDiscontinuity(
      overLimit, std::size(overLimit), 1000, endpoint));
  CHECK(endpoint == 4110);
}

void testPostPumpDiscontinuityKeepsTwoChangedReadings() {
  const Sample s[] = {{1000, 3860}, {1200, 3860}, {1400, 3860}, {1600, 3860},
                      {1800, 3880}, {2000, 4110}, {2200, 4120}, {2400, 8850}};
  int16_t endpoint = 0;
  CHECK(pump_scale::endpointBeforePostPumpDiscontinuity(s, std::size(s), 1000,
                                                        endpoint));
  CHECK(endpoint == 4120);
}

void testPostPumpDiscontinuityRecoveryUsesScaleTimer() {
  const Sample stretchedHostTime[] = {
      {1000, 3860, 1000}, {1200, 3860, 1200}, {1400, 3860, 1400},
      {1600, 3860, 1600}, {1800, 3880, 1800}, {2000, 4110, 2000},
      {2400, 8850, 2300},
  };
  int16_t endpoint = 0;
  CHECK(pump_scale::endpointBeforePostPumpDiscontinuity(
      stretchedHostTime, std::size(stretchedHostTime), 1000, endpoint));
  CHECK(endpoint == 3880);

  const Sample compressedHostTime[] = {
      {1000, 3860, 1000}, {1200, 3860, 1200}, {1400, 3860, 1400},
      {1600, 3860, 1600}, {1800, 3880, 1800}, {2000, 4110, 2000},
      {2200, 8850, 2331},
  };
  CHECK(pump_scale::endpointBeforePostPumpDiscontinuity(
      compressedHostTime, std::size(compressedHostTime), 1000, endpoint));
  CHECK(endpoint == 4110);
}

void testPostPumpDiscontinuityRecoversAcrossHostRollover() {
  const Sample s[] = {
      {0xfffffb00u, 3860}, {0xfffffc00u, 3860}, {0xfffffd00u, 3860},
      {0xfffffe00u, 3860}, {0xffffff00u, 3880}, {0x00000020u, 4110},
      {0x000000e8u, 8850},
  };
  int16_t endpoint = 0;
  CHECK(pump_scale::endpointBeforePostPumpDiscontinuity(s, std::size(s),
                                                        0xfffffb00u, endpoint));
  CHECK(endpoint == 3880);
}

void testSustainedPostPumpGainKeepsFinalEndpoint() {
  std::vector<Sample> s = {
      {1000, 3612}, {1100, 3612}, {1200, 3612}, {1300, 3612}};
  uint32_t t = 1400;
  int16_t cg = 3612;
  for (int i = 0; i < 13; ++i) {
    cg += 12;
    s.push_back({t, cg});
    t += 100;
  }
  s.push_back({t, 0});

  int16_t endpoint = 0;
  CHECK(pump_scale::endpointBeforePostPumpDiscontinuity(s.data(), s.size(),
                                                        1000, endpoint));
  CHECK(endpoint == 3768);
}

void testSustainedPostPumpGainIsCadenceIndependent() {
  for (const uint32_t stepMs : {100u, 150u, 250u}) {
    std::vector<Sample> s;
    uint32_t t = 1000;
    for (int i = 0; i < 5; ++i) {
      s.push_back({t, 3600});
      t += stepMs;
    }
    int16_t cg = 3600;
    for (uint32_t elapsed = stepMs; elapsed <= 1500; elapsed += stepMs) {
      cg += static_cast<int16_t>(40 * stepMs / 1000);
      s.push_back({t, cg});
      t += stepMs;
    }
    s.push_back({t, 0});

    int16_t endpoint = 0;
    CHECK(pump_scale::endpointBeforePostPumpDiscontinuity(s.data(), s.size(),
                                                          1000, endpoint));
    CHECK(endpoint == 3660);
  }
}

void testFastPostPumpTailMovementKeepsFinalEndpoint() {
  // A 0.8 g drop over 100 ms interrupts robust flow but is too small to count
  // as cup or scale movement.
  const Sample s[] = {{900, 4000}, {1000, 4000}, {1100, 3920}};
  int16_t endpoint = 0;
  CHECK(!pump_scale::endpointBeforePostPumpDiscontinuity(s, 3, 1000, endpoint));
}

void testUpwardNudgeDoesNotInflateGain() {
  // A one-sample +24 g spike mid-pour (springing back over the next samples)
  // must not ratchet the run's peak: the spike step is untrusted.
  std::vector<Sample> s;
  uint32_t t = 0;
  double cg = 0;
  flat(s, t, 0.0, 2000);
  ramp(s, t, cg, 180.0, 10000);  // pour to ~18 g
  const int16_t base = static_cast<int16_t>(cg);
  s.push_back(Sample{t, static_cast<int16_t>(base + 2400)});
  t += 150;
  s.push_back(Sample{t, static_cast<int16_t>(base + 1200)});
  t += 150;
  ramp(s, t, cg, 180.0, 11000);  // pour on to ~38 g
  flat(s, t, cg, 3000);
  const auto e = computePourEvidence(s.data(), s.size());
  CHECK(e.hasPour);
  CHECK(e.gainCg >= 3600);
  CHECK(e.gainCg <= 4100);  // the +24 g spike must not be counted
}

void testTailJitterDoesNotRatchetGain() {
  // Small alternating jitter after the pour must not ratchet the peak by more
  // than the jitter amplitude.
  std::vector<Sample> s;
  uint32_t t = 0;
  double cg = 0;
  ramp(s, t, cg, 300.0, 10000);  // pour to ~30 g
  const int16_t base = static_cast<int16_t>(cg);
  for (int i = 0; i < 20; ++i) {
    s.push_back(Sample{t, static_cast<int16_t>(base + ((i & 1) ? 2 : -2))});
    t += 150;
  }
  const auto e = computePourEvidence(s.data(), s.size());
  CHECK(e.hasPour);
  CHECK(e.gainCg >= 2900);
  CHECK(e.gainCg <= 3040);
}

void testNoFlowRejected() {
  std::vector<Sample> s;
  uint32_t t = 0;
  flat(s, t, -8300.0, 20000);
  const auto e = computePourEvidence(s.data(), s.size());
  CHECK(!e.hasPour);
  CHECK(!e.hasStartRawCg);
  CHECK(e.pourMs == 0);
  CHECK(e.gainCg == 0);
}

void testDripTailIncludedInGain() {
  std::vector<Sample> s;
  uint32_t t = 0;
  double cg = 0;
  ramp(s, t, cg, 500.0, 6000);
  ramp(s, t, cg, 15.0, 2000);
  flat(s, t, cg, 3000);
  const auto e = computePourEvidence(s.data(), s.size());
  CHECK(e.hasPour);
  CHECK(e.gainCg >= 2900);
  CHECK(e.gainCg <= 3300);
}

void testTransientBumpDoesNotCorruptGain() {
  std::vector<Sample> s;
  uint32_t t = 0;
  double cg = 0;
  ramp(s, t, cg, 200.0, 4000);
  s.push_back(Sample{t, static_cast<int16_t>(cg - 700)});
  t += 150;
  ramp(s, t, cg, 200.0, 4000);
  flat(s, t, cg, 3000);
  const auto e = computePourEvidence(s.data(), s.size());
  CHECK(e.hasPour);
  CHECK(e.pourMs >= 6500);
  CHECK(e.gainCg >= 1400);
  CHECK(e.gainCg <= 1800);
}

void testSplitPourSumsRuns() {
  std::vector<Sample> s;
  uint32_t t = 0;
  double cg = 0;
  ramp(s, t, cg, 500.0, 5000);
  flat(s, t, cg, 4000);
  ramp(s, t, cg, 500.0, 5000);
  flat(s, t, cg, 3000);
  const auto e = computePourEvidence(s.data(), s.size());
  CHECK(e.hasPour);
  CHECK(e.gainCg >= 4400);
  CHECK(e.pourMs >= 8000);
}

}  // namespace

int main() {
  testSustainedPourRecognized();
  testStartWeightIsLastFlatSampleBeforePour();
  testSmoothedSettledLagDoesNotMoveStartWeightIntoPour();
  testTransientThenFlatPlateauSeedsPourStart();
  testLiftFreezesGainNearPreLiftPeak();
  testPostPumpDiscontinuitySelectsPrecedingEndpoint();
  testSettledReferenceUsesRepeatedScaleReadings();
  testPostPumpDiscontinuityDiscardsRecordedHighReading();
  testPostPumpDiscontinuityDiscardsRecordedLowReading();
  testPostPumpDiscontinuityDoesNotReuseReferenceAcrossGap();
  testPostPumpDiscontinuityFallsBackWithoutSettledReference();
  testPostPumpDiscontinuityDoesNotUsePrePumpReference();
  testPostPumpDiscontinuityKeepsInRangeFinalReading();
  testPostPumpDiscontinuityRecoveryUsesFinalInterval();
  testPostPumpDiscontinuityKeepsTwoChangedReadings();
  testPostPumpDiscontinuityRecoveryUsesScaleTimer();
  testPostPumpDiscontinuityRecoversAcrossHostRollover();
  testSustainedPostPumpGainKeepsFinalEndpoint();
  testSustainedPostPumpGainIsCadenceIndependent();
  testFastPostPumpTailMovementKeepsFinalEndpoint();
  testUpwardNudgeDoesNotInflateGain();
  testTailJitterDoesNotRatchetGain();
  testNoFlowRejected();
  testDripTailIncludedInGain();
  testTransientBumpDoesNotCorruptGain();
  testSplitPourSumsRuns();
  if (g_failures == 0) {
    std::printf("OK: all assertions passed\n");
    return 0;
  }
  std::printf("%d assertion(s) failed\n", g_failures);
  return 1;
}
