import React from 'react';
import PropTypes from 'prop-types';
import styled from '@emotion/styled';
import { NetlifyAuthenticator, ImplicitAuthenticator, PkceAuthenticator } from 'netlify-cms-lib-auth';
import { AuthenticationPage, Icon } from 'netlify-cms-ui-default';

const LoginButtonIcon = styled(Icon)`
  margin-right: 18px;
`;

const clientSideAuthenticators = {
  pkce: ({ base_url, auth_endpoint, app_id, auth_token_endpoint }) =>
    new PkceAuthenticator({ base_url, auth_endpoint, app_id, auth_token_endpoint }),

  implicit: ({ base_url, auth_endpoint, app_id, clearHash }) =>
    new ImplicitAuthenticator({ base_url, auth_endpoint, app_id, clearHash }),
};

export default class GiteaAuthenticationPage extends React.Component {
  static propTypes = {
    onLogin: PropTypes.func.isRequired,
    inProgress: PropTypes.bool,
    base_url: PropTypes.string,
    siteId: PropTypes.string,
    authEndpoint: PropTypes.string,
    config: PropTypes.object.isRequired,
    clearHash: PropTypes.func,
    t: PropTypes.func.isRequired,
  };

  state = {};

  componentDidMount() {
    const {
      auth_type: authType = '',
      base_url = this.props.base_url || 'https://gitea.com',
      auth_endpoint = 'login/oauth/authorize',
      auth_token_endpoint = 'login/oauth/token',
      app_id = '',
    } = this.props.config.backend;

    if (clientSideAuthenticators[authType]) {
      this.auth = clientSideAuthenticators[authType]({
        base_url,
        auth_endpoint,
        app_id,
        auth_token_endpoint,
        clearHash: this.props.clearHash,
      });
      // Complete implicit authentication if we were redirected back to from the provider.
      this.auth.completeAuth((err, data) => {
        if (err) {
          this.setState({ loginError: err.toString() });
          return;
        }
        this.props.onLogin(data);
      });
    } else {
      this.auth = new NetlifyAuthenticator({
        base_url: this.props.base_url,
        site_id:
          document.location.host.split(':')[0] === 'localhost'
            ? 'cms.netlify.com'
            : this.props.siteId,
        auth_endpoint: this.props.authEndpoint,
      });
    }
  }

  handleLogin = e => {
    e.preventDefault();
    this.auth.authenticate({ provider: 'gitea', scope: 'api' }, (err, data) => {
      if (err) {
        this.setState({ loginError: err.toString() });
        return;
      }
      this.props.onLogin(data);
    });
  };

  render() {
    const { inProgress, config, t } = this.props;
    return (
      <AuthenticationPage
        onLogin={this.handleLogin}
        loginDisabled={inProgress}
        loginErrorMessage={this.state.loginError}
        logoUrl={config.logo_url}
        siteUrl={config.site_url}
        renderButtonContent={() => (
          <React.Fragment>
            <LoginButtonIcon type="gitea" />{' '}
            {inProgress ? t('auth.loggingIn') : t('auth.loginWithGitea')}
          </React.Fragment>
        )}
        t={t}
      />
    );
  }
}
