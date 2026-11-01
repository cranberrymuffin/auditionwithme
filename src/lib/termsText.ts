// Full text of the AuditionWithMe Terms and Conditions, shown in
// TermsModal (signup and checkout) and on /terms once beta testing is off.
// Rendered verbatim from "Stephan Dweck Audition With Me Terms and
// Conditions 10 26 26.docx", with its placeholders filled in to match the
// app: the $12.99 monthly fee, the /billing cancel page, no annual plan or
// PayPal, and the auto-renewal consent button as TermsModal's second
// checkbox. Bump TERMS_VERSION whenever this text changes -- acceptance is
// recorded against it (see api/billing.ts accept-terms).
export const TERMS_VERSION = "2026-10-26";
export const TERMS_TITLE = "Terms and Conditions";
export const TERMS_UPDATED = "October 26, 2026";

export type TermsBlock =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; lead?: string; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "address"; lines: string[] };

export const TERMS_BLOCKS: TermsBlock[] = [
  {
    "kind": "paragraph",
    "text": "Welcome to AuditionWithMe."
  },
  {
    "kind": "paragraph",
    "text": "Please read these Terms and Conditions (the “Terms”) carefully. This is an agreement between you (“User,” “you,” or “your”) and Audition with Me LLC, a New York limited liability company (“AuditionWithMe”, “we”, “us”, or “our,”). These Terms govern your use of the AuditionWithMe website located at https://www.auditionwithme.com, the AuditionWithMe downloadable app, and all related forms, tools, mobile applications, web applications, decentralized applications, or other platforms, applications, or services offered by or associated with AuditionWithMe (collectively, the “Application”). The Application and our services related to it are collectively the “Services.”"
  },
  {
    "kind": "paragraph",
    "lead": "Agreement to Terms.",
    "text": "By using our Services, you agree to be bound by these Terms. If you do not agree to be bound by these Terms, do not use the Services. Notwithstanding the foregoing, the laws of some jurisdictions may limit or not permit certain provisions of this agreement, such as indemnification, the exclusion of certain warranties, or the limitation of liability. In such a case, such provisions will apply only to the maximum extent permitted by the laws of such jurisdictions. Also, you may have additional legal rights in your jurisdiction, and nothing in these terms will prejudice such rights that you may have under such applicable law."
  },
  {
    "kind": "paragraph",
    "lead": "End-User License.",
    "text": "Subject to these Terms, AuditionWithMe grants you a personal, non-exclusive, non-transferable, non-sublicensable, limited and revocable license to use the Application for personal use in accordance with these Terms (“User License”). Any use of the Application in any other manner, including, without limitation, resale, reverse-engineering, disassembling, redistribution, transfer, modification or distribution of the Application or content associated with the Application (other than “self-tapes” you record using the Application as described below) is prohibited. This User License also governs any updates to, or supplements or replacements for, the Application unless separate terms accompany such updates, supplements or replacements, in which case the separate terms will apply."
  },
  {
    "kind": "paragraph",
    "text": "The license is effective until terminated by you or AuditionWithMe, with or without written notice. Your rights under the User License will terminate automatically without notice from AuditionWithMe if you fail to comply with any Terms or terms of the User License. Upon termination of the license, you shall cease all use of the Application."
  },
  {
    "kind": "paragraph",
    "lead": "Subscription fee.",
    "text": "Except during the beta testing phase when access is free, AuditionWithMe is a subscription service. Your User License costs USD $12.99 per month, plus any applicable sales, use, VAT, GST or similar taxes required by law. Applicable taxes are calculated based on your billing location and will be added to your subscription where required."
  },
  {
    "kind": "paragraph",
    "lead": "Automatic Renewal.",
    "text": "Your subscription will automatically renew each billing period unless you cancel. Each automatic renewal is for an additional period equal to the billing period you have chosen (one month)."
  },
  {
    "kind": "paragraph",
    "lead": "Cancellation.",
    "text": "You can cancel your subscription anytime online in your account at least ten (10) days before expiration of the then-current billing period. After cancellation, you will continue to have access until the end of the paid period."
  },
  {
    "kind": "paragraph",
    "text": "To cancel a card subscription contract, go to https://www.auditionwithme.com/billing, click the cancel button AND CONFIRM. To cancel an AuditionWithMe subscription created via Apple subscriptions, cancel using your device."
  },
  {
    "kind": "paragraph",
    "lead": "Additional Terms and Policies.",
    "text": "Your use of the Services is subject to additional terms and policies as may be posted on the Services from time to time and that will include the following:"
  },
  {
    "kind": "paragraph",
    "lead": "Privacy Policy.",
    "text": "Please review our Privacy Policy immediately following these Terms, which also governs your use of the Services. By submitting personal data through our Services, you agree to the terms of our Privacy Policy, and you expressly consent to the collection, use, and disclosure of your personal data in accordance with the Privacy Policy."
  },
  {
    "kind": "paragraph",
    "lead": "Third-Party Service Providers.",
    "text": "We may partner with certain third parties to assist with payments, transactions, identify verification, fraud-prevention, and for other legal and compliance functions. Please see our Privacy Policy for additional information on how we may share your personal data with our third-party service providers."
  },
  {
    "kind": "paragraph",
    "lead": "Changes to These Terms or the Services.",
    "text": "We may update the Terms from time to time in our sole discretion. If we do, we’ll let you know by posting the updated Terms on the Application and/or through other means of communication. It is important that you review the Terms whenever we update them or you use the Services, as they govern your use of the Services. If you continue to use the Services after we have updated the Terms, it means that you accept and agree to the changes. If you do not agree to be bound by the changes, you may not use the Services anymore. Because our Services may evolve over time we may change or discontinue all or any part of the Services, at any time and without notice, at our sole discretion."
  },
  {
    "kind": "paragraph",
    "lead": "Who May Use the Services?",
    "text": "The Services are only available to Users in certain jurisdictions who can use the Services as permitted under applicable law. The Services are not authorized for use in certain other jurisdictions that are subject to a U.S. Government embargo, designated by the U.S. Government as a terrorist-supporting country, listed by the U.S. Government as a prohibited or restricted party, or otherwise have U.S. Government or certain international economic sanctions applied. Without limitation, you must be at least 18 years of age to use the Services. You may not attempt to access or use the Services if you are not permitted to do so."
  },
  {
    "kind": "paragraph",
    "lead": "Right to Block Access.",
    "text": "We reserve the right, at any time, in our sole discretion, to block access to the Services from certain IP addresses and unique device identifiers."
  },
  {
    "kind": "paragraph",
    "lead": "Third-Party Copyrightable Content.",
    "text": "You agree to abide by all intellectual property rights of third parties (including rights of such parties in scripts, works of authorship and other written materials). You represent and warrant that you are authorized to upload any sides that you upload to the Application and to record self-tapes of your auditions on the Application and that you will not use any such recordings in any way that violates intellectual property rights of third parties."
  },
  {
    "kind": "heading",
    "text": "About the Services"
  },
  {
    "kind": "paragraph",
    "lead": "Parties.",
    "text": "AuditionWithMe is an AI rehearsal partner for actors that allows you to upload sides a casting director has sent you, choose your role, rehearse with every other character read aloud while your lines follow along on screen, record a self-tape as you go, then download it to submit for your audition. Neither your script nor your self-tapes are stored on our servers. Everything is kept on your device unless you choose to upload it. AuditionWithMe shall have no responsibility to maintain your self-tapes and no liability for your failure to maintain them."
  },
  {
    "kind": "paragraph",
    "lead": "Our Relationship.",
    "text": "AuditionWithMe is an AI rehearsal partner for actors. It is not a talent agency and does not offer, promise, solicit or procure engagements for actors or anyone else."
  },
  {
    "kind": "paragraph",
    "lead": "General Prohibitions.",
    "text": "We reserve the right to take action, with or without advance notice, if we believe you have violated these Terms. This may include disabling your ability to access the Services or other actions. You agree not to do any of the following:"
  },
  {
    "kind": "list",
    "items": [
      "Use, display, mirror or frame the Services or any individual element within the Services, without AuditionWithMe’s express written consent;",
      "Attempt to access or search the Services or download content from the Services using any engine, software, tool, agent, device or mechanism (including spiders, robots, crawlers, data mining tools or the like) other than the software and/or search agents provided by AuditionWithMe or other generally available third-party web browsers;",
      "Use the Services, or any portion thereof, for any commercial purpose or for the benefit of any third party or in any manner not permitted by these Terms;",
      "Knowingly participate in: (i) any technical or hacking attacks on the Application, including but not limited to technical attacks, hacking, or fraud, (ii) conduct reasonably anticipated to cause harm to AuditionWithMe or other Users;",
      "Use the Service in any manner that could interfere with, disrupt, negatively affect or inhibit other Users from fully enjoying the Service;",
      "Violate any applicable law or regulation;",
      "Conduct any other activity that AuditionWithMe considers to be malicious or detrimental; or",
      "Encourage or enable any other individual to do any of the foregoing."
    ]
  },
  {
    "kind": "paragraph",
    "lead": "No Obligation.",
    "text": "AuditionWithMe is not obligated to monitor access to or use of the Services. However, we have the right to do so for the purpose of operating the Services, to ensure compliance with these Terms and to comply with applicable law or other legal requirements. We have the right to investigate violations of these Terms or conduct that affects the Services."
  },
  {
    "kind": "heading",
    "text": "Disclaimers"
  },
  {
    "kind": "paragraph",
    "text": "EXCEPT AS EXPRESSLY PROVIDED TO THE CONTRARY IN A WRITING BY AuditionWithMe, THE SERVICES ARE PROVIDED ON AN “AS IS” AND “AS AVAILABLE” BASIS WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, EITHER EXPRESS OR IMPLIED. AuditionWithMe (AND ITS SUPPLIERS) MAKE NO WARRANTY THAT THE SERVICE: (I) WILL MEET YOUR REQUIREMENTS; (II) WILL BE AVAILABLE ON AN UNINTERRUPTED, TIMELY, SECURE, OR ERROR-FREE BASIS; OR (III) WILL BE ACCURATE, RELIABLE, COMPLETE, LEGAL, OR SAFE. AuditionWithMe DISCLAIMS ALL OTHER WARRANTIES OR CONDITIONS, EXPRESS OR IMPLIED, INCLUDING, WITHOUT LIMITATION, ANY IMPLIED WARRANTY OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE OR NON-INFRINGEMENT, TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW."
  },
  {
    "kind": "paragraph",
    "text": "AuditionWithMe DOES NOT REPRESENT OR WARRANT THAT AuditionWithMe CONTENT ON THE APPLICATION IS ACCURATE, COMPLETE, RELIABLE, CURRENT OR ERROR-FREE. WE WILL NOT BE LIABLE FOR ANY LOSS OF ANY KIND FROM ANY ACTION TAKEN OR NOT TAKEN IN RELIANCE ON MATERIAL OR INFORMATION, CONTAINED ON THE APPLICATION. WHILE AuditionWithMe ATTEMPTS TO MAKE YOUR ACCESS TO AND USE OF THE SERVICES SAFE, AuditionWithMe CANNOT AND DOES NOT REPRESENT OR WARRANT THAT THE SERVICES, APPLICATION, OR OUR SERVERS ARE FREE OF VIRUSES OR OTHER HARMFUL COMPONENTS. WE CANNOT GUARANTEE THE SECURITY OF ANY DATA THAT YOU DISCLOSE ONLINE. YOU ACCEPT THE INHERENT SECURITY RISKS OF PROVIDING INFORMATION AND DEALING ONLINE OVER THE INTERNET AND WILL NOT HOLD US RESPONSIBLE FOR ANY BREACH OF SECURITY UNLESS IT IS DUE TO OUR GROSS NEGLIGENCE."
  },
  {
    "kind": "paragraph",
    "text": "WE WILL NOT BE RESPONSIBLE OR LIABLE TO YOU FOR ANY LOSS AND TAKE NO RESPONSIBILITY FOR, AND WILL NOT BE LIABLE TO YOU FOR, ANY USE OF THE SERVICES, INCLUDING BUT NOT LIMITED TO ANY LOSSES, DAMAGES OR CLAIMS ARISING FROM: (I) USER ERROR SUCH AS FORGOTTEN PASSWORDS, INCORRECTLY CONSTRUCTED TRANSACTIONS, OR MISTYPED ADDRESSES; (II) SERVER FAILURE OR DATA LOSS; (III) UNAUTHORIZED ACCESS TO APPLICATIONS; (IV) DELETION OR OTHER LOSS OF YOUR SELF-TAPES; OR (V) ANY UNAUTHORIZED THIRD PARTY ACTIVITIES, INCLUDING WITHOUT LIMITATION THE USE OF VIRUSES, PHISHING, BRUTEFORCING OR OTHER MEANS OF ATTACK AGAINST THE APPLICATION."
  },
  {
    "kind": "paragraph",
    "text": "Nothing in these Terms shall exclude or limit liability of either party for fraud, violation of laws, or any other activity that cannot be limited or excluded by legitimate means."
  },
  {
    "kind": "paragraph",
    "text": "SOME JURISDICTIONS DO NOT ALLOW THE EXCLUSION OF IMPLIED WARRANTIES IN CONTRACTS WITH CONSUMERS, SO THE ABOVE EXCLUSION MAY NOT APPLY TO YOU."
  },
  {
    "kind": "paragraph",
    "text": "IN NO EVENT SHALL AuditionWithMe OR ANY OF ITS AFFILIATES AND THEIR OFFICERS, DIRECTORS, MANAGER(S), EMPLOYEES, AGENTS, SHAREHOLDERS/MEMBERS BE LIABLE FOR INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL OR EXEMPLARY DAMAGES, WHETHER UNDER ANY TORT, CONTRACT, NEGLIGENCE, STRICT LIABILITY, OR OTHER LEGAL OR EQUITABLE THEORY WHATSOEVER, INCLUDING WITHOUT LIMITATION, DAMAGES FOR LOSS OF PROFITS, INTELLECTUAL PROPERTY INFRINGEMENT, PRICE DEPRECIATION, LEGAL OR REGULATORY ENFORCEMENT, BUSINESS INTERRUPTION, LOSS OF BUSINESS INFORMATION, AND THE LIKE, ARISING OUT OF THIS AGREEMENT, EVEN IF AuditionWithMe HAS BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES."
  },
  {
    "kind": "paragraph",
    "text": "THE FOREGOING DOES NOT AFFECT ANY WARRANTIES THAT CANNOT BE EXCLUDED OR LIMITED UNDER APPLICABLE LAW."
  },
  {
    "kind": "paragraph",
    "lead": "Indemnity.",
    "text": "To the fullest extent permitted by applicable law, you agree to indemnify, defend and hold harmless AuditionWithMe, and our respective past, present and future members, employees, officers, directors, contractors, consultants, vendors, service providers, parent companies, subsidiaries, affiliates, agents, representatives, predecessors, successors, and assigns (individually and collectively, the “AuditionWithMe Parties”), from and against all actual or alleged third-party claims, damages, awards, judgments, losses, liabilities, obligations, penalties, interest, fees, expenses (including, without limitation, reasonable outside attorneys’ fees and expenses) and costs (including, without limitation, court costs, costs of settlement and costs of pursuing indemnification and insurance), of every kind and nature whatsoever, whether known or unknown, foreseen or unforeseen, matured or unmatured, or suspected or unsuspected, in law or equity, whether in tort, contract or otherwise (collectively, “Claims”) that are caused by, arise out of, or are related to: (i) your violation of these Terms; (ii) your breach of any of your representations, warranties or agreements in these Terms; or (iii) your negligence or willful misconduct. You agree to promptly notify AuditionWithMe of any Claims and cooperate with the AuditionWithMe Parties in defending such Claims. You further agree that the AuditionWithMe Parties shall have control of the defense or settlement of any third-party Claims, unless otherwise mutually agreed to, which may be at your cost and expense. AuditionWithMe will have the right to demand and be paid its actual out-of-pocket costs and expenses in connection with any such Claims on an ongoing basis without prejudice to any other remedies available to AuditionWithMe. In any event, you will not settle any Claim without AuditionWithMe ’s prior written consent and you acknowledge and agree that any settlement or attempted settlement of the third-party Claims as described herein without AuditionWithMe’s prior written consent shall be void."
  },
  {
    "kind": "heading",
    "text": "Limitation of Liability"
  },
  {
    "kind": "paragraph",
    "text": "TO THE MAXIMUM EXTENT PERMITTED BY LAW, YOU AGREE THAT IN NO EVENT WILL AuditionWithMe OR ITS SERVICE PROVIDERS INVOLVED IN CREATING, PRODUCING, OR DELIVERING THE SERVICES BE LIABLE FOR ANY INCIDENTAL, SPECIAL, EXEMPLARY OR CONSEQUENTIAL DAMAGES, OR DAMAGES FOR LOST PROFITS, LOST REVENUES, LOST SAVINGS, LOST BUSINESS OPPORTUNITY, LOSS OF DATA OR GOODWILL, SERVICE INTERRUPTION, COMPUTER DAMAGE OR SYSTEM FAILURE OR THE COST OF SUBSTITUTE SERVICES OF ANY KIND ARISING OUT OF OR IN CONNECTION WITH THESE TERMS OR FROM THE USE OF OR INABILITY TO USE THE SERVICES, WHETHER BASED ON WARRANTY, CONTRACT, TORT (INCLUDING NEGLIGENCE), PRODUCT LIABILITY OR ANY OTHER LEGAL THEORY, AND WHETHER OR NOT AuditionWithMe OR ITS SERVICE PROVIDERS HAS BEEN INFORMED OF THE POSSIBILITY OF SUCH DAMAGE, EVEN IF A LIMITED REMEDY SET FORTH HEREIN IS FOUND TO HAVE FAILED OF ITS ESSENTIAL PURPOSE."
  },
  {
    "kind": "paragraph",
    "text": "TO THE MAXIMUM EXTENT PERMITTED BY THE LAW OF THE APPLICABLE JURISDICTION, IN NO EVENT WILL AuditionWithMe’s TOTAL LIABILITY ARISING OUT OF OR IN CONNECTION WITH THESE TERMS, OR FROM THE USE OF OR INABILITY TO USE THE SERVICES EXCEED THE AMOUNTS YOU HAVE PAID FOR THE SERVICES."
  },
  {
    "kind": "paragraph",
    "text": "THE EXCLUSIONS AND LIMITATIONS OF DAMAGES SET FORTH ABOVE ARE FUNDAMENTAL ELEMENTS OF THE BASIS OF THE BARGAIN BETWEEN AuditionWithMe AND YOU."
  },
  {
    "kind": "paragraph",
    "text": "Some jurisdictions do not allow the exclusion or limitation of incidental or consequential damages, so the above limitation or exclusion may not apply to you."
  },
  {
    "kind": "paragraph",
    "lead": "Governing Law and Forum Choice.",
    "text": "These Terms and any action related thereto will be governed by the laws of the State of New York, without regard to its or any other jurisdiction’s conflict of laws principles. The exclusive jurisdiction for all disputes arising from or relating to these Terms and/or the Services will be the state and federal courts located in New York, New York, and you and AuditionWithMe each consent to the personal jurisdiction of such courts and waive any objection to jurisdiction and venue in such courts based on forum non conveniens or otherwise."
  },
  {
    "kind": "heading",
    "text": "General Terms"
  },
  {
    "kind": "paragraph",
    "lead": "Reservation of Rights.",
    "text": "AuditionWithMe and its licensors exclusively own all right, title and interest in and to the Services, including all associated intellectual property rights. You acknowledge that the Services are protected by copyright, trademark, and other laws of the United States and foreign countries. You agree not to remove, alter or obscure any copyright, trademark, service mark or other proprietary rights notices incorporated in or accompanying the Services."
  },
  {
    "kind": "paragraph",
    "lead": "Entire Agreement.",
    "text": "These Terms (including the following Privacy Notice which is incorporated herein by this reference) constitute the entire and exclusive understanding and agreement between AuditionWithMe and you regarding the Services, and these Terms supersede and replace all prior oral or written understandings or agreements between AuditionWithMe and you regarding the Services and/or Application. If any provision of these Terms is held invalid or unenforceable by a court of competent jurisdiction, that provision will be enforced to the maximum extent permissible, and the other provisions of these Terms will remain in full force and effect. You may not assign or transfer these Terms, by operation of law or otherwise, without AuditionWithMe’s prior written consent. Any attempt by you to assign or transfer these Terms, without such consent, will be null. AuditionWithMe may freely assign or transfer these Terms without restriction. Subject to the foregoing, these Terms will bind and inure to the benefit of the parties, their successors and permitted assigns."
  },
  {
    "kind": "paragraph",
    "lead": "Notices.",
    "text": "Any notices or other communications provided by AuditionWithMe under these Terms will be given: (i) via email to info@AuditionWithMe.com; or (ii) by posting to the Application. For notices made by email, the date of receipt will be deemed the date on which such notice is transmitted."
  },
  {
    "kind": "paragraph",
    "lead": "Waiver of Rights.",
    "text": "AuditionWithMe’s failure to enforce any right or provision of these Terms will not be considered a waiver of such right or provision. The waiver of any such right or provision will be effective only if in writing and signed by a duly authorized representative of AuditionWithMe. Except as expressly set forth in these Terms, the exercise by either party of any of its remedies under these Terms will be without prejudice to its other remedies under these Terms or otherwise."
  },
  {
    "kind": "paragraph",
    "lead": "Contact Information.",
    "text": "If you have any questions about these Terms or the Services, please contact AuditionWithMe at info@AuditionWithMe.com or:"
  },
  {
    "kind": "address",
    "lines": [
      "AuditionWithMe, LLC",
      "15 Remsen Avenue",
      "Roslyn, NY 11576"
    ]
  }
];
