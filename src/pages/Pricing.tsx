import { useNavigate } from "react-router-dom";
import SiteNav from "../components/SiteNav";

type Tier = {
  name: string;
  price: string;
  cadence: string;
  tagline: string;
  features: string[];
  cta: string;
  featured?: boolean;
};

const TIERS: Tier[] = [
  {
    name: "Plus",
    price: "$7",
    cadence: "/mo",
    tagline: "Cast every character yourself",
    features: [
      "Hand-pick the voice for every character",
      "Full script practice with word-by-word tracking",
    ],
    cta: "3 Sessions For Free",
  },
  // {
  //   name: "Premium",
  //   price: "Coming soon",
  //   cadence: "",
  //   tagline: "Practice on camera",
  //   features: [
  //     "Everything in Plus",
  //     "Practice your scenes on video",
  //     "Record and store your sessions",
  //   ],
  //   cta: "Notify me",
  //   featured: true,
  // },
  // {
  //   name: "Gold",
  //   price: "Coming soon",
  //   cadence: "",
  //   tagline: "Get coached",
  //   features: [
  //     "Everything in Premium",
  //     "AI acting coach feedback on every take",
  //   ],
  //   cta: "Notify me",
  // },
];

export default function Pricing() {
  const navigate = useNavigate();

  return (
    <div className="home-hero about-page pricing-page">
      <SiteNav />

      <div className="home-text about-text pricing-text">
        <h1 className="home-title about-title">PRICING</h1>
        <p className="home-subtitle pricing-subtitle">
          Start free for 3 sessions. Upgrade when you want more.
        </p>

        <div className="pricing-grid">
          {TIERS.map((tier) => (
            <div
              key={tier.name}
              className={`pricing-card${tier.featured ? " pricing-card--featured" : ""}`}
            >
              {/* <p className="pricing-card__name">{tier.name}</p> */}
              <p className="pricing-card__price">
                {tier.price}
                {tier.cadence && (
                  <span className="pricing-card__cadence">{tier.cadence}</span>
                )}
              </p>
              {/* <p className="pricing-card__tagline">{tier.tagline}</p> */}
              <ul className="pricing-card__features">
                {tier.features.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
              <button
                className="pricing-card__cta"
                onClick={() => navigate("/")}
              >
                {tier.cta}
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="home-hills">
        <svg
          className="home-hill home-hill--back"
          viewBox="0 0 1440 300"
          preserveAspectRatio="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M0,180 C200,80 480,240 720,140 C960,40 1200,160 1440,120 L1440,300 L0,300 Z"
            fill="rgba(232,117,106,0.55)"
          />
        </svg>
        <svg
          className="home-hill home-hill--front"
          viewBox="0 0 1440 300"
          preserveAspectRatio="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M0,240 C240,180 480,280 720,220 C960,160 1200,260 1440,220 L1440,300 L0,300 Z"
            fill="#E8756A"
          />
        </svg>
      </div>
    </div>
  );
}
