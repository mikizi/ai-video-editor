// Lightweight entry point that only registers FamilyMontage — bundles much
// faster than src/index.tsx (which pulls in every composition).
import React from "react";
import { Composition, registerRoot } from "remotion";
import { FamilyMontage, calculateFamilyMontageMetadata, EMPTY_TIMELINE } from "./FamilyMontage";

const MontageRoot: React.FC = () => (
  <Composition
    id="FamilyMontage"
    component={FamilyMontage}
    durationInFrames={30}
    fps={30}
    width={1080}
    height={1920}
    defaultProps={{ timeline: EMPTY_TIMELINE }}
    calculateMetadata={calculateFamilyMontageMetadata}
  />
);

registerRoot(MontageRoot);
